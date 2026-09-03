# SQLite → MySQL 迁移指南（backend/app.db → MySQL 8）

- 日期：2026-09-03
- 目标：把本地 SQLite 开发库（`backend/app.db`）平滑迁移到 MySQL 8，不改动任何业务代码。
- 关联：`backend/app/core/config.py`（`DATABASE_URL` 切换）、`backend/app/db/init_db.py`（运行期建表入口）、`backend/sql/init_mysql.sql`（建空库）、`deploy/docker-compose.yml`（云端全栈 MySQL 部署）。

---

## 0. 交付物清单（对照本次需求）

| # | 需求 | 交付物 | 说明 |
|---|---|---|---|
| 1 | MySQL 建表语句（全部表） | `backend/sql/mysql_schema_migrate.sql` | **由 SQLAlchemy 模型自动生成的 DDL 快照**，含全部 18 张表与索引（JSON/LONGTEXT/外键/唯一约束）。`ENGINE=InnoDB` 与 `utf8mb4` 取自 MySQL 8 库默认字符集与存储引擎；模型变更后重新导出即可 |
| 2 | 数据迁移脚本 | `backend/scripts/migrate_sqlite_to_mysql.py`（核心）＋ `scripts/migrate_sqlite_to_mysql.py`（仓库根薄壳） | 连 SQLite 读、连 MySQL 写；逐表保留主键，处理类型转换、临时关闭外键检查、迁移后行数核对 |
| 3 | 配置切换 | 无需改代码：`DATABASE_URL` 环境变量（`config.py` 已支持），见 §7 | `DATABASE_URL=mysql+pymysql://user:pass@host:3306/dbname?charset=utf8mb4` |
| 4 | docker-compose.yml（MySQL） | `deploy/docker-compose.mysql.yml` | 仅 MySQL 8 服务，挂载 `backend/sql/init_mysql.sql` 自动建空库（utf8mb4/utf8mb4_unicode_ci），仅绑定本机回环 3306 |
| 5 | 一键迁移命令 | `python scripts/migrate_sqlite_to_mysql.py` | 或 `python -m backend.scripts.migrate_sqlite_to_mysql`，等价 |

> **建表哲学**：本仓库表结构以 `backend/app/models`（SQLAlchemy 2.0）为唯一权威，运行期通过
> `backend/app/db/init_db.py` 的 `create_all` 建表（既有 MySQL 云端部署已验证此路径）。因此迁移
> **不手写 DDL**，而是让目标库也走 `create_all`；`mysql_schema_migrate.sql` 只是把同一模型编译成
> 可审阅的 MySQL DDL，供 DBA/评审归档，并可用 `--dump-schema` 随时再生成。

---

## 1. 方案边界（先读）

- **行级整库迁移**：users / patients / scale_results / cognitive_tests / tracking_logs / uploads /
  model_predictions / imaging_visualizations / patient_tasks / care_messages / ai_chat_logs /
  security_* 共 18 张表，主键 `id` 原样保留 → 外键引用关系迁移后依旧成立，后端 `autoincrement` 自动续号。
- **文件不随库走**：`uploads.stored_path` 只记录路径，`.1D`/影像等真实文件本体在
  `UPLOAD_ROOT`（默认 `backend/uploads`），迁移后需另行同步到目标主机同一相对路径。
- **迁移不触碰源库**：全程只读 SQLite。
- **默认防呆**：目标库任何业务表已有数据时**中止**（除非显式 `--drop-first`，危险）。
- **默认不播种**：只搬已有数据；需要演示账号时加 `--seed`（会运行 `seed_demo_data`，production 下该脚本自拒）。

---

## 2. 一键命令

```bash
# 任选其一（作用完全相同）
python scripts/migrate_sqlite_to_mysql.py                       # 薄壳
python -m backend.scripts.migrate_sqlite_to_mysql               # 模块式
```

未传 `--mysql-url` 时，依次取：`DATABASE_URL`（mysql 前缀）→ 环境变量 `MYSQL_HOST/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DB/MYSQL_PORT`。
缺省源库为 `<repo>/backend/app.db`，可用 `--sqlite PATH` 覆盖。

---

## 3. 步骤 A：准备 MySQL

### A1 方式一：仓库自带仅 MySQL compose（本地/演示，推荐）

```bash
docker compose -f deploy/docker-compose.mysql.yml up -d     # 在仓库根执行
docker compose -f deploy/docker-compose.mysql.yml ps        # 等 healthy
```

- 首次初始化会自动执行 `backend/sql/init_mysql.sql` → 建好空库 `adhd_demo`（utf8mb4/utf8mb4_unicode_ci/InnoDB）。
- 默认账号口令（均可用环境变量覆盖，避开 URL 保留字符）：
  - 库名 `adhd_demo`、账号 `adhd`、口令 `adhd-migrate-pw`、root 口令 `adhd-migrate-root-pw`
- 只绑定 `127.0.0.1:3306`，不对外暴露。

对应连接串：

```
mysql+pymysql://adhd:adhd-migrate-pw@127.0.0.1:3306/adhd_demo?charset=utf8mb4
```

### A2 方式二：已有 MySQL / 云 RDS

确认：账号可建/可写目标库、UTF-8、InnoDB（MySQL 8 默认）。PyMySQL 1.1.1 支持 MySQL 8 默认 `caching_sha2_password` 认证。

---

## 4. 步骤 B：先干跑（可选但推荐，不连库、不写数据）

```bash
python scripts/migrate_sqlite_to_mysql.py \
  --mysql-url 'mysql+pymysql://adhd:adhd-migrate-pw@127.0.0.1:3306/adhd_demo?charset=utf8mb4' \
  --dry-run
```

只打印源库各表行数预览与目标连接串，不要求 MySQL 可达。

---

## 5. 步骤 C：正式迁移

```bash
# 最简（连接串也可省略：自动取 DATABASE_URL 或 MYSQL_* 环境变量）
python scripts/migrate_sqlite_to_mysql.py \
  --mysql-url 'mysql+pymysql://adhd:adhd-migrate-pw@127.0.0.1:3306/adhd_demo?charset=utf8mb4'
```

常用参数：

| 参数 | 作用 | 默认 |
|---|---|---|
| `--sqlite PATH` | 源库文件/URL | `backend/app.db` |
| `--mysql-url URL` | 目标连接串 | `DATABASE_URL` → `MYSQL_*` |
| `--no-create-db` | 不自动创建缺失的目标库（账号无建库权限时用） | 自动建库 |
| `--seed` | 迁移完成后播种演示账号/数据（幂等） | 关 |
| `--drop-first` | 先 DROP 目标全部业务表再重建迁移（危险，仅重试） | 关 |
| `--batch-size N` | 每批插入行数 | 500 |
| `--skip-verify` | 跳过迁移后行数核对 | 核对 |
| `--dump-schema [PATH]` | 只导出 MySQL DDL 后退出 | `backend/sql/mysql_schema_migrate.sql` |
| `--dry-run` | 只预览 | 关 |

脚本行为：目标库不存在则用同账号自动 `CREATE DATABASE adhd_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` → 用模型 `create_all` 建全部表 → 临时 `SET FOREIGN_KEY_CHECKS=0` → 按依赖顺序逐表 `executemany` 拷贝（保留 `id`）→ `SET FOREIGN_KEY_CHECKS=1` → 迁移后逐表行数核对。

成功尾部示例：

```
迁移汇总：
  users                        src=6      dst=6      OK
  patients                     src=3      dst=3      OK
  ...
共迁移 18 张表。
```

> `--seed` 需在 `APP_ENV != production` 下生效；如 `backend/.env` 是 production，脚本会以 `development` 覆盖后运行（与“seed 仅用于开发演示”的口径一致）。

---

## 6. 步骤 D：验证

1. **行数核对**：上一步自检已逐表比对；可再跑一次 `--dry-run`（读源）对照。
2. **抽样一致性**（在目标库执行）：

```sql
SELECT u.id, u.email, u.role, p.patient_type, p.age,
       s.scale_type, s.total_score, s.risk_level
FROM users u
JOIN patients p   ON p.user_id = u.id
LEFT JOIN scale_results s ON s.patient_id = p.id
ORDER BY u.id;

SELECT COUNT(*) FROM users;             -- 应等于源库
SELECT COUNT(*) FROM tracking_logs;     -- 应等于源库
```

3. **应用切库冒烟**：见 §7 改 `.env` 后重启，用 `doctor@demo.com` 走一遍医生端登录 + 患者列表 + 报告（等价于把整库换成 MySQL 再验收一遍）。

---

## 7. 配置切换（交付物 #3）

无需改代码。`backend/app/core/config.py` 的加载顺序（dotenv 载入时 `override=False`，环境变量优先）：

1. 若设置了 `DATABASE_URL`（mysql 前缀）→ 直接用（**推荐切库方式**）；
2. 否则 `development/test` 环境 → SQLite `backend/app.db`；
3. 否则（production）→ 要求显式 `DATABASE_URL`，缺则启动报错（安全兜底）。

### 切到 MySQL

在 `backend/.env`（或 shell 导出）加入：

```dotenv
DATABASE_URL=mysql+pymysql://adhd:adhd-migrate-pw@127.0.0.1:3306/adhd_demo?charset=utf8mb4
```

`MYSQL_*`（`MYSQL_HOST/PORT/USER/PASSWORD/DB`）仅作运维对账与部署 compose 注入用；运行时以 `DATABASE_URL` 为准。

**确认已生效**：

```bash
DATABASE_URL='mysql+pymysql://u:pw@127.0.0.1:3306/adhd_demo?charset=utf8mb4' \
python -c "from backend.app.core.config import settings; print(settings.SQLALCHEMY_DATABASE_URI)"
# 应打印 mysql+pymysql://... 而不是 sqlite:///...
```

### 启动后端（幂等建表，可随时重跑）

```bash
python -m backend.create_tables          # create_all + 运行期兼容升级（幂等）
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

> 回到 SQLite：把 `backend/.env` 里 `DATABASE_URL` 那行删掉/注释即可（development 下回落到 `backend/app.db`）。

---

## 8. 类型转换口径（脚本已处理，供人工审阅）

| SQLite → MySQL | 处理 |
|---|---|
| `JSON` | 源反序列化为 Python 对象后交给目标 JSON 列**自行序列化一次**，避免二次编码（嵌套对象/空值均安全） |
| `DateTime(timezone=True)` | 统一转成 **UTC naive** 写 MySQL `DATETIME`（与既有 MySQL 部署读出口径一致，后端按 UTC 解释） |
| `Boolean` | → `0/1`（TINYINT） |
| 枚举列（`SqlEnum native_enum=False`） | SQLAlchemy 存**大写枚举名**（如 `role='RESEARCHER'`、`task_type='SCALE'`），源库与目标库一致，ORM 读取照常解码 |
| `Integer/Float/Text/VARCHAR/LONGTEXT` | 原样；中文等 utf8 多字节由 `utf8mb4` 保证 |
| 主键 `id` | 显式保留 → 外键引用关系不丢；MySQL `AUTO_INCREMENT` 自动续到 max+1 |

---

## 9. 注意事项

- **先备份**：迁移前建议拷贝源 `backend/app.db` 与（如非空）目标库备份，例：
  `cp backend/app.db backend/app.db.bak-20260903`。
- **上传文件本体不在库中**：迁移后把 `backend/uploads`（或 `UPLOAD_ROOT` 指向目录）同步到目标主机同一相对路径，否则报告的影像/预测记录虽在、但文件缺失。
- **`security_mcs_nodes` 等运行期实体随库迁移**：源库已含默认 MCS 节点等，迁移即带回；无需在目标端重播 init 默认值。
- **`--drop-first` 危险**：会把目标库 18 张表全部 DROP 后重建，仅用于"清空重试"。
- **不要在目标库有并发写入时迁移**；迁移为单事务（单表内分批，表间整体在一个事务里），失败自动回滚并保持源库不变。
- 若后续模型改动：迁移脚本导出新 DDL 用 `python -m backend.scripts.migrate_sqlite_to_mysql --dump-schema`，但**表结构变更应走 `create_tables`/增量迁移**，不要让迁移脚本承担 schema 演进。

---

## 10. 回滚

1. 停应用；把 `backend/.env` 的 `DATABASE_URL` 改回 SQLite（删掉那行），重启即回 SQLite 库（源库全程未动，数据完好）。
2. 目标库如需清空重来：
   ```bash
   docker compose -f deploy/docker-compose.mysql.yml down -v   # 删数据卷
   # 或保留服务但清表后重跑：
   python scripts/migrate_sqlite_to_mysql.py --drop-first --mysql-url 'mysql+pymysql://...'
   ```

---

## 11. 常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `OperationalError ... (2003) Can't connect to MySQL server` | MySQL 未起/端口/绑定不对 | `docker compose -f deploy/docker-compose.mysql.yml ps`；确认本机 `127.0.0.1:3306` |
| `OperationalError ... (1045) Access denied` | 账号/口令不符 | 核对 compose 的 `MYSQL_USER/MYSQL_PASSWORD` 与连接串；口令含 `@ : /` 需 URL 编码 |
| `(1049) Unknown database` 且提示建库失败 | 账号无 `CREATE DATABASE` 权限 | 让 DBA 先建库并授权，或用 `--no-create-db` |
| `RuntimeError: DATABASE_URL is required when APP_ENV=production.` | 应用侧想切 MySQL 却只给了 `MYSQL_*` | 在 `backend/.env` 写 `DATABASE_URL=mysql+pymysql://…`（§7） |
| 目标表报 `Table ... already exists` 之外的表结构缺列（`Unknown column`） | 目标 MySQL 是个**旧库**，存在不完整/旧 schema | 用全新空库，或先 `--drop-first` 重建；生产旧库请按 `backend/sql/migrations/` 增量脚本升级（先备份） |
| 目标库已有数据仍执行 | 防呆拦截 | 确认目标确实为空；确要覆盖则加 `--drop-first` |
| JSON 读回发现是"字符串套字符串" | 在源侧即已双重编码的历史脏数据（罕见） | 迁移脚本已按对象还原再写；若仍有问题单独核对那一列 |
| 想再校验表是否与模型一致 | 比较 DDL 快照 | `python -m backend.scripts.migrate_sqlite_to_mysql --dump-schema` 后 diff `backend/sql/mysql_schema_migrate.sql` |
