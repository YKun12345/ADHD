# AB 合并版自动验证报告

## 发布前硬化复验（2026-08-30，提交 `dedbbfd`）

本轮先在存在本地 `backend/.env` 的真实开发环境中复现基线：后端 24 项测试为 9 通过、15 失败。根因是配置模块使用 `load_dotenv(..., override=True)`，把 pytest 临时 SQLite、生产配置边界和旧库升级子进程中的显式环境变量覆盖成开发机配置。修复后，显式 `APP_ENV=test/production` 不再读取开发 `.env`，开发模式的 `.env` 也不会覆盖进程变量。

同时完成以下确定性修复：

- AI 追踪提醒改用专用 `REMINDER_SYSTEM_PROMPT`，避免配置了 Qwen 后仍因未定义名称静默降级。
- 自然语言患者查询显式导入 `Patient` 与 `ScaleResult`，避免已注册 `/api/v1/ai-enhanced` 路径运行时 `NameError`。
- FastAPI 启动迁移到 `lifespan`，Pydantic 响应模型迁移到 `ConfigDict`。
- Ruff 报告的 48 项问题全部清理，包括未定义名称、重复字典键、SQLAlchemy 空值比较、无用导入/变量和无占位 f-string。
- Web 依赖报告和交付清单生成器在 Windows 上显式写入 LF，避免重生成证据时引入整文件 CRLF 差异。

本轮新鲜验证结果：

- 微信小程序：`node --test miniprogram/tests/*.test.js`，77/77 通过，0 失败、0 跳过。
- 后端：`.venv\Scripts\python.exe -m pytest backend/tests -q`，27/27 通过。
- 后端告警：仅剩 1 条 Starlette `WSGIMiddleware` 第三方弃用提示；FastAPI `on_event` 与 Pydantic class Config 告警已消除。
- Web/仓库：`.venv\Scripts\python.exe -m unittest tests.test_web_dependency_audit tests.test_repository_cleanliness tests.test_delivery_manifest -v`，14/14 通过。
- 静态检查：`.venv\Scripts\python.exe -m ruff check backend` 输出 `All checks passed!`。
- Python 编译：`.venv\Scripts\python.exe -m compileall -q backend findviz` 通过。
- Web 依赖：扫描 95 个文件、86 条引用，缺失 0 条。
- 差异检查：排除进入本轮前已存在且未被本轮修改的 `miniprogram/project.config.json` 换行差异后，`git diff --check` 通过。

`miniprogram/project.config.json` 的未提交改动属于进入本轮前已经存在的工作区状态，本轮未覆盖、未暂存、未提交。现有 `docs/evidence/delivery-manifest.json` 对应此前交付提交；由于工作区仍有该用户文件改动，本轮不伪造“洁净交付清单”，应在该文件由项目负责人确认处理后再刷新清单。

真实 MySQL、真实 HGST 权重、微信开发者工具编译、Android/iOS 真机、医院网络以及医学/合规验收仍未在本机完成，不能据此宣称临床或生产就绪。

## 最终独立审查修复复验（2026-08-30）

独立代码审查发现的公开源码暴露、固定 DAC 账号、数字广度字段不一致、旧认知类型遗漏、Mock 标识不醒目、旧库上传关联约束不足和无界上传读取均已修复，并加入回归测试。

- 微信小程序：`node --test miniprogram/tests/*.test.js`，77/77 通过。
- 后端：`python -m pytest backend/tests -q`，24/24 通过；包含旧 SQLite 升级的唯一性、引用完整性和删除置空测试。
- Web/仓库：`python -m unittest tests.test_web_dependency_audit tests.test_repository_cleanliness -v`，11/11 通过。
- Python 编译：`python -m compileall -q backend findviz`，通过。
- 已确认 `/doctor-web/login.html` 返回 200，而 `/backend/app/main.py`、`/miniprogram/app.json` 和 `/archive/legacy-patient-web/patient_home.html` 返回 404。
- 仍有 55 条第三方/旧接口弃用警告（Starlette WSGI、FastAPI `on_event`、Pydantic class `Config`），不阻断测试，但属于后续技术债。

真实 MySQL 服务、真实 HGST 权重、微信开发者工具、真机、医院网络及医学/合规验收仍未在本机完成，不得据此宣称临床或生产就绪。

- 验证日期：2026-08-30（Asia/Shanghai）
- 被验证提交：`7aa1ff0`（`feature/ab-merge`）
- 环境：Windows、Python 3.11.9、Node.js 24.19.0
- 结论：本报告列出的自动化、SQLite、HTTP、Web 依赖与仓库洁净度检查通过；人工、真实模型、真实 MySQL、微信平台和医学/合规验收仍未完成。

## 1. 微信小程序

命令：

```text
node --test miniprogram/tests/*.test.js
```

结果：77 项通过，0 失败、0 跳过。

结构与语法检查：

- `app.json` 注册页面：21
- 具备 `.js/.json/.wxml/.wxss` 完整文件组：21
- 可解析 JSON：29
- 通过 `node --check` 的 JavaScript：135
- A 小程序与 B 后端静态契约测试包含在 77 项中并通过

## 2. 后端

命令：

```text
python -m pytest backend/tests -q
python -m compileall -q backend findviz
```

结果：15 项通过；Python 编译检查通过。

覆盖重点：开发/生产配置边界、健康检查、七类认知任务归一化与未知类型拒绝、综合报告、上传格式/大小/落盘/SHA-256/来源状态、真实推理错误边界、显式 Mock 标识、两次种子幂等。

测试产生 37 条弃用警告，尚未阻断运行：

- Starlette `WSGIMiddleware` 已弃用；
- FastAPI `on_event` 已弃用；
- 现有部分 Pydantic class `Config` 应迁移至 `ConfigDict`。

这些是已记录技术债务，不应被描述为“零缺陷”。

## 3. SQLite 初始化与种子幂等

使用全新临时 SQLite 数据库依次执行建表、种子、计数、再次种子、再次计数。两次计数完全相同：

```json
{
  "cognitive_tests": 14,
  "model_predictions": 2,
  "patients": 2,
  "scale_results": 2,
  "tracking_logs": 28,
  "uploads": 0,
  "users": 4
}
```

14 条认知结果对应 2 个演示患者各 7 类认知任务。临时数据库已删除。

## 4. Web 结构、依赖与 HTTP

根目录测试命令：

```text
python -m unittest tests.test_web_dependency_audit tests.test_repository_cleanliness -v
python tools/web_dependency_audit.py --root . --output docs/evidence/web-dependency-report.json --exclude archive --exclude miniprogram --exclude findviz/templates --exclude findviz/static/js/main.js --exclude HGST-main
```

结果：Web/洁净度合计 10 项通过；活动范围扫描 95 个文件、86 条本地引用、0 条缺失。

使用临时 SQLite 和 Uvicorn 实际启动后，以下 14 个路径全部返回 HTTP 200：

```text
/
/api/v1/health
/docs
/doctor-web/
/doctor-web/login.html
/doctor-web/doctor_analysis.html
/doctor-web/doctor_patients.html
/doctor-web/doctor_report.html
/doctor-web/doctor_imaging.html
/doctor-web/doctor_visualization.html
/doctor-web/dac_dashboard.html
/doctor-web/css/style.css
/doctor-web/js/api.js
/findviz/static/js/utils.js
```

进程、日志和临时数据库均已清理。旧患者网页只存在于 `archive/legacy-patient-web/`，活动医生端不再引用 `patient_*.html` 或 `clinical_pathway.html`。

## 5. 仓库洁净度和敏感信息

命令：

```text
powershell -NoProfile -ExecutionPolicy Bypass -File tools/merge/verify_clean_tree.ps1 -Repository . -Python .venv\Scripts\python.exe
```

结果：8 项仓库洁净度检查通过，`git diff --check` 通过，验证前 Git 工作树干净。

- 扫描跟踪文件：578
- 禁止的 `.env`、数据库、密钥证书文件名：0
- 私钥、非空 Qwen/MySQL 凭据模式命中：0
- 个人绝对 Windows 路径仅允许出现在来源/设计追溯材料中
- `.venv`、`node_modules`、缓存、日志、上传、模型权重和数据库均未跟踪

## 6. 验证过程中发现并已修正的问题

1. 原 README 的 `node --test miniprogram/tests` 在 Node 24/Windows 下不能把目录展开为测试文件；已改为实际通过的 `node --test miniprogram/tests/*.test.js`。
2. 发现 4 个无活动引用的旧机器绑定脚本：聊天日志导出、root 系统安装和两个 findviz 一次性补丁脚本；它们含个人绝对路径或危险的机器级副作用，已从 AB 合并版删除，A/B 原目录未改。
3. PowerShell 默认执行策略会拦截 `.ps1`；验证命令明确使用 `-ExecutionPolicy Bypass`，不修改系统全局策略。
4. 第一次 HTTP 检查关闭服务后 Windows 短暂占用临时 SQLite 句柄；确认端口释放并删除后，使用 `WaitForExit` 重新执行，14 个路径仍全为 200 且临时产物清理成功。

## 7. 尚未完成、不得误报为通过

- 微信开发者工具实际导入和编译；
- Android、iOS 各一次真机完整流程；
- 正式 AppID、HTTPS、request 合法域名、证书和备案；
- 真实 MySQL 服务器上的初始化、迁移、备份恢复和并发验证；
- PyTorch/DHG、批准的 HGST 权重、标签和真实影像数据下的真实模型验证；
- 医院网络、权限、隐私、日志、灾备和安全合规验收；
- 医学阈值、性能指标、适用人群、报告措辞和临床有效性审查。

详细人工项目见 `docs/evidence/manual-acceptance.md`。本报告只证明所列工程检查在本机环境通过，不构成医学有效性、医疗器械合规性、临床可用性或生产就绪证明。
