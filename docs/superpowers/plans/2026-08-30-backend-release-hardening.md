# Backend Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复后端测试与部署配置隔离，修复已注册 API 路径中的确定性运行时缺陷，并形成可重复的发布前验证证据。

**Architecture:** 保持现有小程序、医生 Web、FastAPI 路由和数据库模型边界不变。配置文件仅提供缺省值，应用启动改用 lifespan，AI 服务修复模型依赖与专用提示词，静态清理不改变业务契约。

**Tech Stack:** Python 3.11、FastAPI 0.115、SQLAlchemy 2、Pydantic 2、pytest、Ruff、Node.js 原生测试运行器

---

### Task 1: 配置优先级与测试隔离

**Files:**
- Modify: `backend/app/core/config.py`
- Test: `backend/tests/test_health.py`
- Test: `backend/tests/test_schema_upgrade.py`
- Test: `backend/tests/test_cognitive_contract.py`

- [ ] **Step 1: 运行现有失败测试**

Run: `.venv\Scripts\python.exe -m pytest backend/tests/test_health.py::test_health_uses_temporary_sqlite backend/tests/test_health.py::test_production_requires_explicit_database_url backend/tests/test_schema_upgrade.py::test_legacy_sqlite_model_prediction_upload_link_is_constrained -q`

Expected: FAIL；临时数据库未创建、生产配置未拒绝、旧库未升级，证明 `backend/.env` 覆盖显式环境变量。

- [ ] **Step 2: 修复 dotenv 优先级**

将开发环境文件加载限制为开发模式，并禁止覆盖进程变量：

```python
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=True)
```

改为：

```python
if os.getenv("APP_ENV", "development").strip().lower() == "development":
    load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)
```

- [ ] **Step 3: 验证配置与完整后端测试**

Run: `.venv\Scripts\python.exe -m pytest backend/tests -q`

Expected: 现有 24 项测试全部通过。

### Task 2: AI 运行时回归保护

**Files:**
- Create: `backend/tests/test_ai_runtime.py`
- Modify: `backend/app/services/ai_service.py`
- Modify: `backend/app/services/natural_language_query_service.py`
- Modify: `backend/app/models/patient.py`

- [ ] **Step 1: 编写 AI 提醒失败测试**

测试替换 `qwen_client.chat` 为返回合法提醒 JSON 的假实现，调用 `_provider_or_fallback_reminder`，断言系统提示词为 `REMINDER_SYSTEM_PROMPT` 且返回 `is_fallback=False`。

- [ ] **Step 2: 编写自然语言查询失败测试**

用最小假数据库执行 `_execute_patient_search`，断言能返回一个患者；修复前应因 `ScaleResult` 未定义失败。

- [ ] **Step 3: 运行新测试确认 RED**

Run: `.venv\Scripts\python.exe -m pytest backend/tests/test_ai_runtime.py -q`

Expected: FAIL，分别暴露 `CHAT_SYSTEM_PROMPT` 和 `ScaleResult` 未定义。

- [ ] **Step 4: 实施最小修复**

```python
# ai_service.py
{"role": "system", "content": REMINDER_SYSTEM_PROMPT}

# natural_language_query_service.py
from backend.app.models.patient import Patient
from backend.app.models.scale_result import ScaleResult

# patient.py TYPE_CHECKING
from backend.app.models.upload import Upload
```

同时删除重复的 `TIME_KEYWORDS["最近两周"]`，不改变映射值。

- [ ] **Step 5: 验证 GREEN**

Run: `.venv\Scripts\python.exe -m pytest backend/tests/test_ai_runtime.py -q`

Expected: PASS。

### Task 3: FastAPI/Pydantic 生命周期升级

**Files:**
- Modify: `backend/app/main.py`
- Modify: `backend/app/schemas/tracking.py`
- Test: `backend/tests/test_health.py`

- [ ] **Step 1: 编写弃用失败测试**

子进程导入 `backend.app.main` 并捕获告警，断言 stderr 不含 `on_event is deprecated` 和 `class-based config`。

- [ ] **Step 2: 运行测试确认 RED**

Run: `.venv\Scripts\python.exe -m pytest backend/tests/test_health.py::test_backend_import_avoids_owned_deprecations -q`

Expected: FAIL，输出包含两个目标弃用信息。

- [ ] **Step 3: 使用 lifespan 和 ConfigDict**

```python
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield

app = FastAPI(..., lifespan=lifespan)
```

```python
from pydantic import BaseModel, ConfigDict

class TrackingLogResponse(TrackingLogBase):
    model_config = ConfigDict(from_attributes=True)
```

- [ ] **Step 4: 验证启动语义与告警**

Run: `.venv\Scripts\python.exe -m pytest backend/tests/test_health.py -q`

Expected: PASS；启动建库和旧 DAC 禁用行为保持不变。

### Task 4: Ruff 确定性缺陷清理

**Files:**
- Modify: `backend/app/**/*.py`（仅 Ruff 已报告位置）
- Test: Ruff 静态检查

- [ ] **Step 1: 保存 RED 证据**

Run: `.venv\Scripts\python.exe -m ruff check backend --output-format concise`

Expected: FAIL，当前报告 48 项，包括未定义名称、重复键、无效 None 比较、无用导入/变量和无占位 f-string。

- [ ] **Step 2: 应用安全自动修复并人工处理剩余项**

Run: `.venv\Scripts\python.exe -m ruff check backend --fix`

人工修复剩余的 `F821`、`F841`、`E711` 与 `E731`，只删除死代码或改写等价表达式，不改变接口字段或算法结果。

- [ ] **Step 3: 验证静态检查**

Run: `.venv\Scripts\python.exe -m ruff check backend`

Expected: `All checks passed!`

### Task 5: 全栈回归与证据

**Files:**
- Modify: `docs/evidence/verification-report.md`

- [ ] **Step 1: 后端完整验证**

Run: `.venv\Scripts\python.exe -m pytest backend/tests -q`

Expected: 全部通过。

- [ ] **Step 2: 小程序与仓库验证**

Run: `node --test miniprogram/tests/*.test.js`

Run: `.venv\Scripts\python.exe -m unittest tests.test_web_dependency_audit tests.test_repository_cleanliness tests.test_delivery_manifest -v`

Expected: 小程序 77 项与仓库 14 项全部通过。

- [ ] **Step 3: 编译与差异检查**

Run: `.venv\Scripts\python.exe -m compileall -q backend findviz`

Run: `git diff --check`

Expected: 两条命令退出码均为 0。

- [ ] **Step 4: 更新验证报告**

记录本次新鲜命令、通过数量、修复范围、用户原有未提交文件，以及仍需外部环境完成的微信真机、MySQL、HGST 和医学合规验收。
