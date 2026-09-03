# AB 合并版后端

本目录以 B 的 FastAPI 后端为主线，服务 A 微信小程序和 `doctor-web/` 医生端。完整启动说明以仓库根目录 `README.md` 为准。

## 最小开发流程

从仓库根目录执行：

```bash
python -m venv .venv
pip install -r requirements.txt
python -m backend.create_tables
python -m backend.scripts.seed_demo_data
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

先把根目录 `.env.example` 复制为 `backend/.env`。开发默认使用 SQLite；生产环境必须显式设置数据库 URL 和非占位密钥。

可访问：

- `http://127.0.0.1:8000/api/v1/health`
- `http://127.0.0.1:8000/docs`
- `http://127.0.0.1:8000/doctor-web/`

## 数据库

- SQLite：`DATABASE_URL=sqlite:///./backend/app.db`
- MySQL：执行 `backend/sql/init_mysql.sql`，再设置完整 `DATABASE_URL`
- 本地数据库、上传目录和模型输出都被 Git 忽略
- 演示种子幂等，但只应写入空白或专用演示数据库

## 模型接口

推理模式由 `USE_MOCK_MODEL` 决定（`real` 默认 / `auto` / `mock`，语义与日志见 `docs/hgst-model-integration.md`）：

- `/api/v1/model/predict_fmri`：模式感知推理入口。`real`（默认）为真实 HGST，依赖/权重缺失时返回 503，不静默降级；`auto` 会降级为带标识 Mock；`true` 恒走演示 Mock（真上传假结果）。
- `/api/v1/model/predict_mock`：无需上传的显式演示端点，响应带 `is_demo=true`，不能作为医学诊断。
- 模型自检：`python scripts/verify_model.py`（真实权重契约见 `backend/models/README.md`）。

模型扩展依赖见 `requirements-hgst.txt`，上传文件默认写到 `backend/uploads/`。不要把真实影像、患者信息、密钥或模型权重提交到仓库。

## 测试

```bash
python -m pytest backend/tests -q
python -m compileall -q backend findviz
```

自动测试不等于医学有效性、临床安全性或生产合规性验证。
