"""Bounded connection use must never cache an authorization decision."""
from types import SimpleNamespace
import sqlite3
import pytest


def ledger_world(monkeypatch,tmp_path):
    # The autouse fixture already selects isolated keys and stores.
    from backend.app.services import authorization_ledger as ledger
    monkeypatch.setattr(ledger.settings,'AUTHORIZATION_LEDGER_PATH',str(tmp_path/'heads.db'))
    monkeypatch.setattr(ledger.settings,'DATABASE_URL','sqlite:///'+(tmp_path/'business.db').as_posix())
    connections=[]
    original=sqlite3.connect
    class Tracked(sqlite3.Connection):
        closed=False
        def close(self):
            super().close(); self.closed=True
    def connect(*args,**kwargs):
        kwargs['factory']=Tracked
        value=original(*args,**kwargs); connections.append(value); return value
    monkeypatch.setattr(ledger.sqlite3,'connect',connect)
    ledger.initialize_ledger()
    row=SimpleNamespace(ledger_key='synthetic-current-head',revision=1)
    ledger.reserve(row); ledger.publish(row)
    return ledger,row,connections


def test_each_independent_ledger_operation_closes_its_connection(monkeypatch,tmp_path):
    ledger,row,connections=ledger_world(monkeypatch,tmp_path)
    assert ledger.matches(row)
    assert connections and all(value.closed for value in connections)


def test_one_read_scope_reuses_connection_but_a_concurrent_denial_is_visible(monkeypatch,tmp_path):
    ledger,row,connections=ledger_world(monkeypatch,tmp_path)
    from concurrent.futures import ThreadPoolExecutor
    start=len(connections)
    with ledger.read_heads():
        assert ledger.matches(row)
        assert ledger.matches(row)
        assert len(connections)==start+1
        with ThreadPoolExecutor(max_workers=1) as executor:
            changed=SimpleNamespace(ledger_key=row.ledger_key,revision=1)
            executor.submit(ledger.deny,changed).result(timeout=5)
        assert ledger.matches(row) is False
        assert changed.revision==2
        with ledger.read_heads():
            assert ledger.matches(row) is False
    assert all(value.closed for value in connections)


def test_ledger_read_connection_closes_after_exception(monkeypatch,tmp_path):
    ledger,row,connections=ledger_world(monkeypatch,tmp_path)
    with pytest.raises(RuntimeError):
        with ledger.read_heads():
            assert ledger.matches(row)
            raise RuntimeError('synthetic abort')
    assert all(value.closed for value in connections)
