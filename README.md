# ADHD 智慧辅助诊断平台 — AB 合并版

## 发布安全边界（2026-08-30 审查后）

- 后端只公开 `/doctor-web` 和 `/findviz` 所需资源，不再把仓库根目录作为静态站点；`.env`、数据库、上传文件、小程序源码和历史归档不能通过 HTTP 读取。
- 服务启动不会创建固定 DAC 管理账号，也会禁用旧库中的公开遗留账号 `admin123`。演示 DAC 只由 `python -m backend.scripts.seed_demo_data` 显式创建，且该脚本拒绝在 `APP_ENV=production` 下运行。
- 旧 SQLite 库启动升级时会为 `model_predictions.upload_id` 增加唯一索引及关联完整性触发器。旧 MySQL 库请先备份，再执行 `backend/sql/migrations/20260830_model_prediction_upload_link_mysql.sql`；全新数据库由 SQLAlchemy 模型创建等价的唯一外键。
- 影像 Mock 结果在医生报告中显示红色“演示 Mock”提示和后端免责声明；真实推理失败不会静默降级成 Mock。
- 上传接口分块读取并执行服务器端硬上限，不会在检查大小前读取整个任意大文件。

这是独立于 A、B 原目录的新版本：患者端以 A 的原生微信小程序为主，服务端以 B 的 FastAPI 后端为主，B 的医生/研究人员 Web 保留为活动入口。B 的旧患者网页没有删除，已放入只读意义上的历史归档。

本项目是科研与演示软件，不是独立医疗器械。自动测试通过不代表医学有效性、临床安全性或生产合规性已经验证。

## 1. 目录与归属

```text
backend/                    B 后端主线（FastAPI、数据库、接口）
miniprogram/                A 患者端主线（微信小程序，21 个页面）
doctor-web/                 B 医生/研究人员活动 Web
findviz/                    影像可视化服务与静态资源
HGST-main/                  HGST 模型工程
archive/legacy-patient-web/ B 旧患者网页，仅归档，不参与默认运行
tests/                      跨端、结构与洁净度测试
tools/                      审计和交付工具
docs/evidence/              来源、契约、验证与人工验收证据
docs/history/               A/B 合并前的历史材料
```

## 2. 环境要求

- Python 3.11
- Node.js 20 或更高版本（只用于小程序自动测试）
- 微信开发者工具（用于编译、预览和真机验收）
- 可选：MySQL 8；不安装时默认使用 SQLite
- 可选：真实 HGST 推理所需的 PyTorch、DHG、模型权重和数据标签

所有命令均从仓库根目录执行。不要复制 A、B 原目录内已有的 `.venv`。

```bash
python -m venv .venv
```

激活环境后安装依赖：

```bash
python -m pip install --upgrade pip
pip install -r requirements.txt
```

开发测试还需要：

```bash
pip install -r requirements-dev.txt
```

## 3. 配置

唯一环境模板是根目录 `.env.example`。把它复制为 `backend/.env`：

```powershell
Copy-Item .env.example backend/.env
```

Linux/macOS 可使用 `cp .env.example backend/.env`。开发默认值使用 `sqlite:///./backend/app.db`；生产环境必须设置 `APP_ENV=production`、非占位 `SECRET_KEY` 和显式 `DATABASE_URL`。不要提交 `backend/.env`、数据库、上传文件、权重或真实患者资料。

## 4. SQLite 快速启动

```bash
python -m backend.create_tables
python -m backend.scripts.seed_demo_data
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

种子脚本可重复执行，不会重复膨胀演示数据，并会在终端显示仅供本地演示的账号。启动后检查：

- API 根：`http://127.0.0.1:8000/`
- 健康检查：`http://127.0.0.1:8000/api/v1/health`
- OpenAPI：`http://127.0.0.1:8000/docs`
- 医生端：`http://127.0.0.1:8000/doctor-web/`

医生端必须通过 HTTP 访问；不要双击 HTML。患者请使用微信小程序，不要把 `archive/legacy-patient-web/` 当成活动入口。

## 5. MySQL 启动

1. 在 `backend/.env` 设置 `DATABASE_URL=mysql+pymysql://用户:密码@主机:3306/adhd_demo?charset=utf8mb4`。
2. 使用 MySQL 客户端执行 `backend/sql/init_mysql.sql`。
3. 依次运行 `python -m backend.create_tables`、`python -m backend.scripts.seed_demo_data` 和 Uvicorn 启动命令。

`init_mysql.sql` 建立数据库和上传链路所需结构，其余当前业务表由 SQLAlchemy `create_all` 补齐。正式环境应采用受控迁移工具和备份流程，不应把 `create_all` 当成完整生产迁移方案。

## 6. 微信小程序

1. 微信开发者工具选择“导入项目”，目录选 `miniprogram/`；配置文件为 `miniprogram/project.config.json`。
2. 先启动后端，在小程序登录页打开“服务器连接设置”。开发者工具可填 `http://127.0.0.1:8000/api/v1`；真机要填电脑局域网地址或已备案的 HTTPS 地址。
3. 开发阶段按团队规范决定是否临时关闭合法域名校验；正式发布必须配置 HTTPS、request 合法域名、证书和备案。
4. 使用种子脚本输出的患者演示账号检查登录、量表、七类认知任务、14 天追踪、报告、关怀路径和 AI 页面。

仓库不代填正式 AppID、生产域名、证书、数据库口令或医院配置。

## 7. 模型与演示 Mock 边界

推理模式由环境变量 `USE_MOCK_MODEL` 决定（见 `backend/app/core/config.py` 与 `docs/hgst-model-integration.md`）：

- 留空 / `false` / `strict`：真实 HGST 推理（默认）。`POST /api/v1/model/predict_fmri` 需要安装 `requirements-hgst.txt` 并配置有效权重/部署包；依赖或权重缺失时返回 503，**绝不静默降级成 Mock**。
- `true`：恒走演示 Mock（“真上传、假结果”，`is_demo=true`，响应带明确演示来源与免责声明），供答辩/联调，不构成真实诊断。
- `auto`：真实优先；真实 HGST 不可用（缺依赖/权重）时自动降级为带 `is_demo=true` 标识的 Mock 并打告警日志。
- `POST /api/v1/model/predict_mock`：无需真实上传的显式演示端点（确定性假结果，`is_demo=true`），联调用。响应含演示免责，不得作为医学诊断。

模型加载校验与自检见 `backend/scripts/verify_model.py`（快捷命令 `python scripts/verify_model.py`）。真实权重放 `backend/models/`，说明见 `backend/models/README.md`。
`QWEN_API_KEY` 为空时，AI 文本能力会使用明确的模板降级路径；这同样不是临床结论。

## 8. 自动测试

```bash
node --test miniprogram/tests/*.test.js
python -m pytest backend/tests -q
python -m unittest tests.test_web_dependency_audit tests.test_repository_cleanliness -v
```

还应运行小程序 JSON/页面完整性、全部 JavaScript 语法、后端编译、两次种子、HTTP 和敏感信息检查。最近一次完整结果见 `docs/evidence/verification-report.md`。

## 9. 尚需人工或外部环境验收

必须按 `docs/evidence/manual-acceptance.md` 完成微信开发者工具、Android/iOS 真机、医生浏览器流程、真实模型权重和部署配置验收。没有这些外部条件时，只能标记“待验收”，不能声称可直接用于临床或生产。

来源和合并决策见 `docs/evidence/source-manifest.md` 与 `docs/superpowers/specs/2026-08-30-ab-merge-design.md`。
