"""Latest authority heads live outside business backups. Never rebuild from business rows."""
from pathlib import Path
import sqlite3
import os
from contextlib import contextmanager,closing
from contextvars import ContextVar
from sqlalchemy.engine import make_url
from fastapi import HTTPException
from backend.app.core.config import settings

_read_scope=ContextVar('authorization_ledger_read_scope',default=None)


def _signature():
    return settings.AUTHORIZATION_LEDGER_PATH,settings.SQLALCHEMY_DATABASE_URI


def _path():
    value = settings.AUTHORIZATION_LEDGER_PATH
    if not value:
        raise HTTPException(503, "Independent authorization ledger is not configured.")
    path = Path(value).resolve()
    url = make_url(settings.SQLALCHEMY_DATABASE_URI)
    if url.get_backend_name() == "sqlite" and url.database and url.database != ":memory:":
        database_path = url.database
        if database_path.startswith("file:"):
            from urllib.parse import urlsplit
            from urllib.request import url2pathname
            database_path = url2pathname(urlsplit(database_path).path)
        business = Path(database_path).resolve()
        same = os.path.normcase(str(path)) == os.path.normcase(str(business))
        if path.exists() and business.exists():
            same = same or path.samefile(business)
        if same:
            raise HTTPException(503, "Authorization ledger must be separate from the business database.")
    return path


def initialize_ledger():
    """Only explicit provisioning, or isolated test startup, may initialize this store."""
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as connection:
        with connection as db:
            db.execute("CREATE TABLE IF NOT EXISTS authorization_heads (ledger_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, active INTEGER NOT NULL)")


@contextmanager
def _connect(*,read_only=False):
    path = _path()
    if not path.is_file():
        raise HTTPException(503, "Independent authorization ledger is unavailable.")
    options={'uri':True,'timeout':10}
    if read_only: options['isolation_level']=None
    with closing(sqlite3.connect(f"file:{path.as_posix()}?mode={'ro' if read_only else 'rw'}",**options)) as connection:
        with connection:
            yield connection


@contextmanager
def read_heads():
    """Reuse a bounded read connection; each SELECT still reads the current head."""
    current=_read_scope.get()
    if current is not None and current[0]==_signature():
        yield
        return
    with _connect(read_only=True) as connection:
        token=_read_scope.set((_signature(),connection))
        try:
            yield
        finally:
            _read_scope.reset(token)


def matches(row, active=True):
    try:
        current=_read_scope.get()
        if current is not None and current[0]==_signature():
            head=current[1].execute("SELECT revision,active FROM authorization_heads WHERE ledger_key=?",(row.ledger_key,)).fetchone()
        else:
            with _connect(read_only=True) as db:
                head = db.execute("SELECT revision,active FROM authorization_heads WHERE ledger_key=?", (row.ledger_key,)).fetchone()
        return bool(head and head[0] == row.revision and bool(head[1]) == active)
    except (sqlite3.Error, HTTPException, OSError):
        return False


def reserve(row):
    try:
        with _connect() as db:
            db.execute("INSERT INTO authorization_heads VALUES (?,?,0)", (row.ledger_key, row.revision))
    except sqlite3.Error as exc:
        raise HTTPException(503, "Authorization ledger reservation failed.") from exc


def deny(row):
    """Deny first, monotonically advance. A failed business commit cannot restore access."""
    try:
        with _connect() as db:
            cursor = db.execute("UPDATE authorization_heads SET revision=?,active=0 WHERE ledger_key=? AND revision=?", (row.revision + 1, row.ledger_key, row.revision))
            if cursor.rowcount != 1:
                raise HTTPException(409, "Authorization head is missing or revision conflicts.")
    except sqlite3.Error as exc:
        raise HTTPException(503, "Authorization denial could not be persisted.") from exc
    row.revision += 1


def publish(row,required_heads=()):
    try:
        with _connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for key,revision in required_heads:
                head = db.execute("SELECT revision,active FROM authorization_heads WHERE ledger_key=?",(key,)).fetchone()
                if not head or head[0] != revision or not head[1]:
                    raise HTTPException(409,"The grant's initiating authority changed before activation.")
            cursor = db.execute("UPDATE authorization_heads SET active=1 WHERE ledger_key=? AND revision=? AND active=0", (row.ledger_key, row.revision))
            if cursor.rowcount != 1:
                raise HTTPException(409, "Authorization head is missing or revision conflicts.")
    except sqlite3.Error as exc:
        raise HTTPException(503, "Authorization activation failed; access remains denied.") from exc
