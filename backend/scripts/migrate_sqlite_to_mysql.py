#!/usr/bin/env python
"""SQLite -> MySQL 一键迁移脚本。

用途
----
把本地开发库 ``backend/app.db``（SQLite）迁移到 MySQL 8。

- 目标表结构由 SQLAlchemy 模型（``backend/app/models``）权威生成，
  不手写 DDL，避免与模型漂移；``--dump-schema`` 可导出供审阅的 MySQL DDL 文件。
- 逐表拷贝并保留原主键，外键引用随之成立；迁移期间临时关闭目标库外键检查。
- 支持数据类型的 SQLite->MySQL 转换（JSON、datetime、bool、int/float、长文本）。

用法
----
推荐（与 seed_demo_data 一致）::

    python -m backend.scripts.migrate_sqlite_to_mysql --mysql-url 'mysql+pymysql://adhd:pass@127.0.0.1:3306/adhd_demo?charset=utf8mb4'

等价于仓库根薄壳（同样可用）::

    python scripts/migrate_sqlite_to_mysql.py --mysql-url 'mysql+pymysql://...'

常用参数
--------
--sqlite PATH           源 SQLite 库（默认 <repo>/backend/app.db）
--mysql-url URL         目标 MySQL 连接串；缺省依次取环境变量 DATABASE_URL、MYSQL_*
--no-create-db          不自动创建不存在的目标数据库
--drop-first            先 DROP 目标库所有表再重建（危险，仅用于重试）
--batch-size N          每批插入行数（默认 500）
--skip-verify           跳过迁移后行数核对
--seed                  迁移完成后执行 seed_demo_data（幂等；production 下脚本自拒）
--dump-schema PATH      仅导出模型对应的 MySQL 建表 DDL 到文件并退出
--dry-run               只打印两端库的每个表行数，不写数据

安全
----
默认在目标库任何业务表已有数据时中止（除非 --drop-first）。迁移前请先备份源库
与目标库。上传的真实文件（UPLOAD_ROOT/backend/uploads 下）不随库迁移，需另行同步。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus

import sqlalchemy as sa
from sqlalchemy import MetaData, Table, create_engine, inspect, select, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import IntegrityError, OperationalError

logger = logging.getLogger("migrate_sqlite_to_mysql")

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
DEFAULT_SQLITE_PATH = (BACKEND_DIR / "app.db").resolve()
DEFAULT_SCHEMA_PATH = BACKEND_DIR / "sql" / "mysql_schema_migrate.sql"


# ---------------------------------------------------------------------------
# URL / 路径辅助
# ---------------------------------------------------------------------------

def to_sqlite_url(raw: str) -> str:
    """把 ``--sqlite`` 的文件路径或 sqlite:// URL 统一成 URL。"""
    if raw.startswith("sqlite"):
        return raw
    return f"sqlite:///{Path(raw).expanduser().resolve().as_posix()}"


def mysql_url_from_env() -> str | None:
    """从 compose/后端常用的 MYSQL_* 环境变量拼出连接串。"""
    host = os.getenv("MYSQL_HOST", "").strip()
    user = os.getenv("MYSQL_USER", "").strip()
    db = os.getenv("MYSQL_DB", "").strip()
    if not (host and user and db):
        return None
    password = quote_plus(os.getenv("MYSQL_PASSWORD", ""))
    port = os.getenv("MYSQL_PORT", "3306").strip()
    return f"mysql+pymysql://{user}:{password}@{host}:{port}/{db}?charset=utf8mb4"


def resolve_mysql_url(arg: str | None) -> str:
    if arg and arg.strip():
        return arg.strip()
    env_url = os.getenv("DATABASE_URL", "").strip()
    if env_url.startswith("mysql"):
        return env_url
    composed = mysql_url_from_env()
    if composed:
        return composed
    raise SystemExit(
        "未提供目标 MySQL。请用 --mysql-url 传连接串，或设置环境变量\n"
        "  DATABASE_URL=mysql+pymysql://user:pass@host:3306/dbname?charset=utf8mb4\n"
        "或 MYSQL_HOST/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DB/MYSQL_PORT。"
    )


# ---------------------------------------------------------------------------
# DDL 导出（供审阅；真正建表以 create_all 为准）
# ---------------------------------------------------------------------------

def _load_metadata():
    """导入全部模型以注册到 Base.metadata（此时尚未触碰数据库）。"""
    from backend.app.db.base import Base  # noqa: F401
    import backend.app.models  # noqa: F401  (注册 __tablename__)
    return Base.metadata


def render_mysql_schema(metadata) -> str:
    """把模型元数据编译成 MySQL 建表 DDL（含索引），供审阅/审计。"""
    from sqlalchemy.dialects import mysql
    from sqlalchemy.schema import CreateIndex, CreateTable

    dialect = mysql.dialect()
    lines = [
        "-- ADHD 后端 MySQL 目标表结构（由 SQLAlchemy 模型自动生成，勿手改；模型变更后请重新导出）。",
        "-- 生成命令：python -m backend.scripts.migrate_sqlite_to_mysql --dump-schema",
        "-- 依赖：先建库（utf8mb4 / utf8mb4_unicode_ci），InnoDB 与默认字符集取自 MySQL 8 库默认；",
        "--       如需独立指定，可对生成的每个 CREATE TABLE 追加 ENGINE=InnoDB DEFAULT CHARSET=utf8mb4。",
        "",
        "SET NAMES utf8mb4;",
        "SET FOREIGN_KEY_CHECKS=0;",
    ]
    for table in metadata.sorted_tables:
        ddl = str(CreateTable(table).compile(dialect=dialect)).rstrip()
        lines.append(ddl + ";")
        for index in table.indexes:
            ddl_idx = str(CreateIndex(index).compile(dialect=dialect)).rstrip()
            lines.append(ddl_idx + ";")
    lines.append("SET FOREIGN_KEY_CHECKS=1;")
    lines.append("")
    return "\n\n".join(lines)


# ---------------------------------------------------------------------------
# 数据拷贝（保留主键，类型转换；对 SQLite/MySQL 目标均可用）
# ---------------------------------------------------------------------------

def _convert_value(column, value):
    """按目标列类型把源值转成可安全插入的 Python 值。"""
    if value is None:
        return None
    ctype = column.type

    if isinstance(ctype, sa.types.JSON):
        # 统一还原为 Python 对象，再由目标 JSON 列自行序列化一次，
        # 避免"已序列化字符串再被 json.dumps"导致的二次编码。
        if isinstance(value, str):
            value = json.loads(value)
        elif isinstance(value, (bytes, bytearray)):
            value = json.loads(value.decode("utf-8"))
        return value

    if isinstance(ctype, sa.types.Boolean):
        return 1 if value else 0

    if isinstance(ctype, sa.types.DateTime):
        dt = value
        if isinstance(dt, str):
            dt = datetime.fromisoformat(dt.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt

    if isinstance(ctype, sa.types.Date):
        if isinstance(value, str):
            from datetime import date
            return date.fromisoformat(value)
        return value

    if isinstance(ctype, sa.types.Integer) and isinstance(value, bool):
        return int(value)

    return value


def _count_rows(engine: Engine, table_name: str) -> int:
    with engine.connect() as conn:
        return conn.scalar(text(f"SELECT COUNT(*) FROM {table_name}")) or 0


def copy_table(
    src_engine: Engine,
    dst_conn,
    table_name: str,
    dst_table: Table,
    batch_size: int,
) -> int:
    """拷贝单表所有行到目标（含 id），返回行数。源用 typed 反射读取。"""
    src_table = Table(table_name, MetaData(), autoload_with=src_engine)
    cols = [col for col in dst_table.columns]
    ins = sa.insert(dst_table)
    copied = 0
    buffer: list[dict] = []

    with src_engine.connect() as src_conn:
        for row in src_conn.execute(select(src_table)):
            values = {col.name: _convert_value(col, row._mapping.get(col.name)) for col in cols}
            buffer.append(values)
            copied += 1
            if len(buffer) >= batch_size:
                dst_conn.execute(ins, buffer)
                buffer.clear()
    if buffer:
        dst_conn.execute(ins, buffer)
    return copied


def _table_names(src_engine: Engine, metadata) -> list[str]:
    """两端都有的业务表，按依赖（父表在前）排序，剔除 SQLite 内部表。"""
    src_names = set(inspect(src_engine).get_table_names())
    known = {t.name for t in metadata.sorted_tables}
    ordered = [t.name for t in metadata.sorted_tables if t.name in src_names]
    extra = sorted(src_names - known - {"sqlite_sequence", "alembic_version"})
    return ordered + extra


def copy_database(src_engine: Engine, dst_engine: Engine, metadata, batch_size=500, skip_verify=False):
    """执行整库拷贝；返回 (表名, 源行数, 目标行数) 列表。

    目标库需已建好表结构。期间对 MySQL 临时关闭外键检查以保留原 id 引用。
    拷贝前 DELETE 清空对应表，防止上一次失败留下的残留（正常路径目标为空表）。
    """
    tables = _table_names(src_engine, metadata)
    report = []

    with dst_engine.connect() as dst_conn:
        trans = dst_conn.begin()
        is_mysql = dst_engine.dialect.name == "mysql"
        if is_mysql:
            dst_conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))

        try:
            for name in tables:
                if name not in metadata.tables:
                    logger.info("跳过非模型表: %s", name)
                    continue
                dst_table = metadata.tables[name]
                src_count = _count_rows(src_engine, name)
                if src_count == 0:
                    logger.info("表 %-28s 源库为空，跳过", name)
                    report.append((name, 0, 0))
                    continue
                dst_conn.execute(text(f"DELETE FROM {name}"))  # 防上一轮失败残留
                n = copy_table(src_engine, dst_conn, name, dst_table, batch_size)
                logger.info("表 %-28s 拷贝 %d 行", name, n)
                report.append((name, src_count, n))
        except Exception:
            trans.rollback()
            raise
        if is_mysql:
            dst_conn.execute(text("SET FOREIGN_KEY_CHECKS=1"))
        trans.commit()

    # 行数核对
    if not skip_verify:
        mismatches = [
            (name, src_n, _count_rows(dst_engine, name))
            for name, src_n, _ in report
            if src_n and _count_rows(dst_engine, name) != src_n
        ]
        if mismatches:
            raise RuntimeError("迁移后行数不一致: " + ", ".join(
                f"{name}(src={a},dst={b})" for name, a, b in mismatches
            ))
    return report


# ---------------------------------------------------------------------------
# 目标库初始化（可选自动建库/建表/DROP）
# ---------------------------------------------------------------------------

def ensure_database_exists(mysql_url: str) -> None:
    """目标库不存在时用同账号创建（utf8mb4）。失败则给出可读报错。"""
    parsed = make_url(mysql_url)
    dbname = parsed.database or ""
    try:
        tmp = create_engine(mysql_url, pool_pre_ping=False)
        with tmp.connect():
            pass
        tmp.dispose()
        return  # 已存在
    except OperationalError as exc:
        tmp.dispose()
        is_bad_db = False
        for arg in getattr(exc.orig, "args", []) or []:
            code = getattr(arg, "code", None) if not isinstance(arg, int) else arg
            if code == 1049 or (isinstance(arg, str) and "Unknown database" in arg):
                is_bad_db = True
        if not is_bad_db:
            raise

    if not dbname:
        raise RuntimeError("MySQL URL 缺少数据库名，无法自动创建。")

    import pymysql
    conn = pymysql.connect(
        host=parsed.host,
        port=parsed.port or 3306,
        user=parsed.username,
        password=parsed.password or "",
        charset="utf8mb4",
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"CREATE DATABASE IF NOT EXISTS `{dbname}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
        conn.commit()
        logger.info("已创建目标库 %s (utf8mb4/utf8mb4_unicode_ci)", dbname)
    finally:
        conn.close()


def drop_all_tables(engine: Engine, metadata) -> None:
    """按依赖倒序 DROP 目标库表（--drop-first 用）。"""
    with engine.connect() as conn:
        conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        for table in reversed(metadata.sorted_tables):
            conn.execute(text(f"DROP TABLE IF EXISTS {table.name}"))
        conn.execute(text("SET FOREIGN_KEY_CHECKS=1"))
        conn.commit()
    logger.warning("已 DROP 目标库全部业务表。")


def guarded_recreate(engine: Engine, metadata, drop_first: bool) -> None:
    """建表（create_all，幂等）。已有数据且未 --drop-first 时中止。"""
    existing = []
    with engine.connect() as conn:
        for table in metadata.sorted_tables:
            count = conn.scalar(text(f"SELECT COUNT(*) FROM {table.name}")) or 0
            if count:
                existing.append((table.name, count))
    if existing:
        if not drop_first:
            raise SystemExit(
                "目标库已有数据，中止迁移以免重复。相关表: "
                + ", ".join(f"{n}({c})" for n, c in existing[:10])
                + "。若确认可清空重来，请加 --drop-first。"
            )
        drop_all_tables(engine, metadata)
    metadata.create_all(bind=engine)


# ---------------------------------------------------------------------------
# 播种（可选，--seed）
# ---------------------------------------------------------------------------

def run_seed_demo() -> None:
    """对 MySQL 执行官方演示数据播种（幂等，production 自拒）。"""
    from backend.app.db.session import SessionLocal  # noqa: F401  确保引擎指向 MySQL
    from backend.scripts.seed_demo_data import seed_demo_data
    seed_demo_data()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="migrate_sqlite_to_mysql",
        description="把 backend/app.db (SQLite) 迁移到 MySQL。",
    )
    p.add_argument("--sqlite", default=str(DEFAULT_SQLITE_PATH),
                   help=f"源 SQLite 库（默认 {DEFAULT_SQLITE_PATH}）")
    p.add_argument("--mysql-url", default=None,
                   help="目标 MySQL 连接串；缺省取 DATABASE_URL 或 MYSQL_*")
    p.add_argument("--no-create-db", action="store_true",
                   help="不自动创建缺失的目标数据库")
    p.add_argument("--drop-first", action="store_true",
                   help="先 DROP 目标库全部业务表再重建并迁移（危险）")
    p.add_argument("--batch-size", type=int, default=500, help="每批插入行数")
    p.add_argument("--skip-verify", action="store_true", help="跳过迁移后行数核对")
    p.add_argument("--seed", action="store_true", help="迁移完成后执行 seed_demo_data")
    p.add_argument("--dump-schema", metavar="PATH", nargs="?", const=str(DEFAULT_SCHEMA_PATH),
                   help="仅导出 MySQL 建表 DDL（默认写 backend/sql/mysql_schema_migrate.sql）后退出")
    p.add_argument("--dry-run", action="store_true", help="只预览两端各表行数，不写入")
    p.add_argument("--log-level", default="INFO")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(levelname)s %(message)s",
    )

    metadata = _load_metadata()

    # 仅导出 DDL：不要求 MySQL 可达
    if args.dump_schema is not None:
        path = Path(args.dump_schema)
        text_ddl = render_mysql_schema(metadata)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text_ddl, encoding="utf-8")
        print(f"MySQL 建表 DDL 已导出: {path}")
        return 0

    # 源库
    sqlite_url = to_sqlite_url(args.sqlite)
    if sqlite_url.startswith("sqlite:///") and not Path(
        sqlite_url.replace("sqlite:///", "", 1)
    ).exists():
        raise SystemExit(f"找不到源 SQLite 库: {sqlite_url}（可用 --sqlite 指定）")

    mysql_url = resolve_mysql_url(args.mysql_url)

    # 关键顺序：先写环境，再导入会缓存 settings/engine 的后端模块。
    os.environ["DATABASE_URL"] = mysql_url
    os.environ.setdefault("APP_ENV", "development")
    if args.seed:
        os.environ["APP_ENV"] = "development"

    src_engine = create_engine(sqlite_url, connect_args={"check_same_thread": False})

    with src_engine.connect() as conn:
        src_tables = set(inspect(conn).get_table_names())
    if not src_tables:
        logger.warning("源库没有业务表，仅初始化目标结构。")
    else:
        counts = {}
        with src_engine.connect() as conn:
            for name in sorted(src_tables - {"sqlite_sequence"}):
                counts[name] = conn.scalar(text(f"SELECT COUNT(*) FROM {name}")) or 0
        logger.info("源库表数预览：%s", {k: v for k, v in sorted(counts.items())})

    # 预览无需 MySQL 可达
    if args.dry_run:
        print(f"dry-run：目标 {mysql_url}，未写入任何数据。去掉 --dry-run 后正式迁移。")
        return 0

    if not args.no_create_db:
        ensure_database_exists(mysql_url)

    dst_engine = create_engine(mysql_url, pool_pre_ping=True)

    guarded_recreate(dst_engine, metadata, args.drop_first)

    report = copy_database(src_engine, dst_engine, metadata,
                           batch_size=args.batch_size, skip_verify=args.skip_verify)

    print("\n迁移汇总：")
    for name, src_n, dst_n in report:
        status = "OK" if src_n == dst_n else "MISMATCH"
        print(f"  {name:<30} src={src_n:<6} dst={dst_n:<6} {status}")
    print(f"共迁移 {len(report)} 张表。")

    if args.seed:
        print("执行 seed_demo_data ...")
        run_seed_demo()
        print("seed_demo_data 完成（仅演示账号/数据；production 下会自动拒绝）。")

    print("\n完成。后续步骤：")
    print(f"  1) 确认 .env 的 DATABASE_URL 指向 MySQL（当前为 {mysql_url}）")
    print("  2) python -m backend.create_tables   # 幂等，可选（运行时也会建表）")
    print("  3) 同步 UPLOAD_ROOT/backend/uploads 下真实文件（库不包含文件本体）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
