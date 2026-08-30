# AB Merge Edition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a third, clean, reproducible AB merge edition that keeps A's complete WeChat mini-program, B's backend, the active doctor Web workflow, and an auditable history without changing either source directory.

**Architecture:** A's Git history is the base. A's current mini-program is imported as an immutable snapshot, then B's current backend and integration assets are imported in a separate commit. A thin contract layer normalizes the seven cognitive task payloads and upload provenance; Web cleanup happens only after a generated dependency audit proves which pages are active.

**Tech Stack:** WeChat Mini Program JavaScript/WXML/WXSS, Node.js built-in test runner, Python 3.11, FastAPI, Pydantic 2, SQLAlchemy 2, SQLite/MySQL, static HTML/CSS/JavaScript, Git, PowerShell.

---

## Locked file structure

The following ownership is fixed for this plan:

- `miniprogram/`: A current workspace, with only contract fixes added in the merge repository.
- `backend/`: B current workspace, excluding runtime state.
- `doctor-web/`: active doctor/researcher static pages after dependency verification.
- `archive/legacy-patient-web/`: superseded patient Web pages, retained for history but excluded from default startup.
- `tests/`: cross-end contract and repository cleanliness tests.
- `tools/merge/`: deterministic source inventory, import, dependency audit, and delivery verification tools.
- `docs/evidence/`: generated source manifests, contract tables, test reports, and remaining manual checks.
- `docs/history/`: historical progress documents that no longer describe the current runtime.

Files expected to be created or materially modified:

- Create `tools/merge/source_inventory.ps1`
- Create `tools/merge/verify_clean_tree.ps1`
- Create `tools/web_dependency_audit.py`
- Create `tests/test_web_dependency_audit.py`
- Create `tests/test_repository_cleanliness.py`
- Create `backend/tests/conftest.py`
- Create `backend/tests/test_health.py`
- Create `backend/tests/test_cognitive_contract.py`
- Create `backend/tests/test_model_upload.py`
- Create `backend/tests/test_seed_idempotency.py`
- Create `backend/app/services/cognitive_contract.py`
- Create `backend/app/services/upload_storage.py`
- Modify `backend/app/api/routes/patient.py`
- Modify `backend/app/api/routes/model_inference.py`
- Modify `backend/app/models/model_prediction.py`
- Modify `backend/app/models/upload.py`
- Modify `backend/app/models/patient.py`
- Modify `backend/app/schemas/cognitive.py`
- Modify `backend/app/schemas/model_inference.py`
- Modify `backend/app/core/config.py`
- Modify `backend/scripts/seed_demo_data.py`
- Modify `backend/sql/init_mysql.sql`
- Modify `miniprogram/utils/request.js` only if a measured route/field mismatch requires it
- Modify `miniprogram/utils/report-data.js` only if the B response adapter cannot be isolated in the request layer
- Create `miniprogram/tests/backend-contract.test.js`
- Create `doctor-web/README.md`
- Create `.env.example`
- Modify `.gitignore`
- Modify `requirements.txt`
- Create `requirements-dev.txt`
- Create `README.md`
- Create `docs/evidence/source-manifest.md`
- Create `docs/evidence/api-contract.md`
- Create `docs/evidence/web-dependency-report.json`
- Create `docs/evidence/verification-report.md`
- Create `docs/evidence/manual-acceptance.md`

## Task 1: Record immutable sources and import A's current workspace

**Files:**
- Create: `tools/merge/source_inventory.ps1`
- Create: `docs/evidence/source-manifest.md`
- Replace from A: `miniprogram/`
- Import selectively from A: current documentation and shared assets that are not backend-owned

- [ ] **Step 1: Add a deterministic source inventory script**

Create `tools/merge/source_inventory.ps1` with parameters `Source`, `Label`, and `OutputFile`. Resolve `Source`, reject a missing directory, enumerate files excluding `.git`, `.venv`, `node_modules`, caches, logs, databases, temporary folders and secrets, calculate SHA-256, and write sorted UTF-8 JSON containing `label`, `source`, `generated_at`, `git_head`, `git_status`, and `files`.

The exclusion predicate must contain these normalized path fragments:

```powershell
$excluded = @(
  '/.git/', '/.venv/', '/venv/', '/node_modules/', '/__pycache__/',
  '/.pytest_cache/', '/logs/', '/tmp/', '/downloads/', '/.codex-tmp/',
  '/.worktrees/', '/.superpowers/'
)
$excludedNames = @('.env', 'app.db', 'Thumbs.db', '.DS_Store')
```

- [ ] **Step 2: Run the inventory against both sources without writing to them**

Run:

```powershell
powershell -NoProfile -File tools/merge/source_inventory.ps1 -Source 'C:\Users\Lenovo\Desktop\源码' -Label A -OutputFile docs/evidence/source-a.json
powershell -NoProfile -File tools/merge/source_inventory.ps1 -Source 'D:\xwechat_files\wxid_3toll5v8nbqt22_16a1\msg\file\2026-08\源码(3)\源码' -Label B -OutputFile docs/evidence/source-b.json
```

Expected: both commands print a file count and SHA-256 manifest checksum; neither source Git status gains entries.

- [ ] **Step 3: Import A's current mini-program using the inventory exclusion rules**

Copy A's `miniprogram/` into the isolated repository with `robocopy /MIR`, explicitly excluding `.git`, dependency/cache/runtime directories, databases and secrets. Because the destination is the isolated clone, `/MIR` may remove only stale files inside the destination `miniprogram/`; it must never target either source.

Expected: `miniprogram/app.json` registers 21 pages and `miniprogram/tests` contains 76 `*.test.js` files.

- [ ] **Step 4: Verify A's snapshot**

Run:

```powershell
$tests = Get-ChildItem miniprogram/tests -Filter '*.test.js' | Sort-Object FullName | ForEach-Object FullName
node --test $tests
```

Expected: `tests 76`, `pass 76`, `fail 0`.

- [ ] **Step 5: Write source provenance and commit A snapshot**

`docs/evidence/source-manifest.md` must state both absolute source paths, A baseline `f175d53`, the import time, import/exclusion rules, and that uncommitted A work is preserved in this snapshot commit.

```powershell
git add miniprogram tools/merge/source_inventory.ps1 docs/evidence/source-a.json docs/evidence/source-b.json docs/evidence/source-manifest.md
git commit -m "snapshot(A): import current mini-program workspace"
```

Expected: one commit containing A's current 21-page mini-program and no backend replacement.

## Task 2: Import B's backend and integration assets as a separate commit

**Files:**
- Replace from B: `backend/`
- Replace from B: `findviz/`
- Replace from B: `HGST-main/`
- Import from B: active root HTML, `css/`, `js/`, `tools/`, `requirements.txt`, `requirements-hgst.txt`
- Preserve from A: `miniprogram/`, `.git/`, `docs/superpowers/`

- [ ] **Step 1: Copy B-owned modules into the isolated repository**

Use separate, explicit `robocopy` calls for each approved directory. Exclude `.venv`, `node_modules`, `__pycache__`, `.pytest_cache`, `logs`, `tmp`, `downloads`, `artifacts`, `app.db`, `.env`, compiled Python files, model weights and local output files.

- [ ] **Step 2: Copy B root integration files without touching the mini-program**

Copy only the enumerated HTML pages, `css/`, `js/`, `requirements*.txt`, `setup_server.sh`, `export_chat_logs.py`, B README and B verification document. Do not use a root-level mirror command.

- [ ] **Step 3: Prove ownership boundaries**

Run the 76 A tests again and compare `miniprogram/` against the Task 1 commit:

```powershell
git diff --exit-code HEAD -- miniprogram
$tests = Get-ChildItem miniprogram/tests -Filter '*.test.js' | ForEach-Object FullName
node --test $tests
```

Expected: no mini-program diff caused by B import; all tests pass.

- [ ] **Step 4: Compile B Python sources**

Run:

```powershell
python -m compileall -q backend findviz
```

Expected: exit code 0; generated `__pycache__` directories remain ignored.

- [ ] **Step 5: Commit B import**

```powershell
git add backend findviz HGST-main css js tools *.html requirements.txt requirements-hgst.txt setup_server.sh export_chat_logs.py
git commit -m "import(B): backend model and doctor web assets"
```

Expected: B import is independently revertible and contains no environment/runtime artifacts.

## Task 3: Establish clean, reproducible project boundaries

**Files:**
- Modify: `.gitignore`
- Create: `.env.example`
- Create: `requirements-dev.txt`
- Create: `tests/test_repository_cleanliness.py`
- Create: `tools/merge/verify_clean_tree.ps1`

- [ ] **Step 1: Write a failing repository cleanliness test**

Create `tests/test_repository_cleanliness.py` using `unittest`. It must walk tracked files from `git ls-files -z`, fail for path segments `.venv`, `venv`, `node_modules`, `__pycache__`, `.pytest_cache`, `logs`, `tmp`, `downloads`, and fail for names `.env`, `app.db`, extensions `.pyc`, `.pth`, `.pt`, `.ckpt`. It must also reject text matching private-key headers or assignments to `SECRET_KEY`, `QWEN_API_KEY`, and database passwords unless the file is `.env.example` and the value is an obvious placeholder.

- [ ] **Step 2: Run the test and capture existing violations**

Run `python -m unittest tests.test_repository_cleanliness -v`.

Expected: fail with the exact currently tracked violations, or pass if the imported source is already clean. Any failure becomes an explicit removal action in Step 3.

- [ ] **Step 3: Implement the clean boundary**

`.gitignore` must include:

```gitignore
.env
.venv/
venv/
node_modules/
__pycache__/
*.py[cod]
.pytest_cache/
backend/app.db
backend/uploads/
backend/artifacts/
logs/
tmp/
downloads/
*.pt
*.pth
*.ckpt
```

Create `.env.example` with SQLite development defaults, placeholder security/API values, CORS origins, `MODEL_MODE=mock`, and blank optional HGST paths. Pin development-only `pytest`, `httpx`, and `ruff` in `requirements-dev.txt`.

- [ ] **Step 4: Add a PowerShell pre-delivery wrapper**

`tools/merge/verify_clean_tree.ps1` must run the cleanliness test, `git diff --check`, and `git status --short`; it exits non-zero when tests fail or when prohibited files are tracked.

- [ ] **Step 5: Verify and commit**

Run `python -m unittest tests.test_repository_cleanliness -v` and expect PASS.

```powershell
git add .gitignore .env.example requirements-dev.txt tests/test_repository_cleanliness.py tools/merge/verify_clean_tree.ps1
git commit -m "chore: enforce clean reproducible repository boundaries"
```

## Task 4: Add an isolated backend test harness and portable SQLite startup

**Files:**
- Create: `backend/tests/conftest.py`
- Create: `backend/tests/test_health.py`
- Modify: `backend/app/core/config.py`
- Modify: `backend/app/db/session.py` only if engine reloading is required by tests

- [ ] **Step 1: Write the failing health/startup test**

The fixture must create a temporary directory, set `DATABASE_URL=sqlite:///<temporary>/test.db`, set a test secret, reload configuration/session modules before importing the app, create tables, and yield `fastapi.testclient.TestClient`. The test must assert:

```python
def test_health_uses_temporary_sqlite(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
```

- [ ] **Step 2: Run the focused test and verify the measured failure**

Run `python -m pytest backend/tests/test_health.py -q`.

Expected before implementation: failure showing either missing dev dependencies, MySQL fallback, or stale settings import.

- [ ] **Step 3: Make development startup portable**

Change `backend/app/core/config.py` so an explicitly supplied `DATABASE_URL` wins; when no URL is supplied, use a repository-relative SQLite database only in development mode. Production mode must reject the default secret and require an explicit database URL. Keep existing MySQL environment variables for documented migration compatibility.

- [ ] **Step 4: Run the focused test**

Run `python -m pytest backend/tests/test_health.py -q`.

Expected: `1 passed` and the database exists only inside the temporary test directory.

- [ ] **Step 5: Commit**

```powershell
git add backend/tests/conftest.py backend/tests/test_health.py backend/app/core/config.py backend/app/db/session.py
git commit -m "test: add isolated backend startup harness"
```

## Task 5: Define and enforce the seven-task cognitive contract

**Files:**
- Create: `backend/app/services/cognitive_contract.py`
- Create: `backend/tests/test_cognitive_contract.py`
- Modify: `backend/app/schemas/cognitive.py`
- Modify: `backend/app/api/routes/patient.py`
- Create: `docs/evidence/api-contract.md`

- [ ] **Step 1: Write failing contract tests**

Tests must assert the canonical ordered types are:

```python
("reaction", "simple_reaction", "stroop", "trail", "flanker", "nback", "digit")
```

They must submit canonical A payloads with `result_json.raw_result` and `finished_at`, reject unknown types with HTTP 422, accept legacy B seed keys through normalization, and assert the comprehensive report includes all seven latest items. A simple-reaction-only result must contribute to `reaction_speed`; Go/No-Go `reaction` remains the source for false-start inhibitory scoring.

- [ ] **Step 2: Run the tests and verify failure**

Run `python -m pytest backend/tests/test_cognitive_contract.py -q`.

Expected: failure because B currently omits `simple_reaction` and accepts arbitrary test types.

- [ ] **Step 3: Implement the contract module**

`backend/app/services/cognitive_contract.py` must export:

```python
CANONICAL_COGNITIVE_TYPES = (
    "reaction", "simple_reaction", "stroop", "trail", "flanker", "nback", "digit"
)
COGNITIVE_TYPE_ALIASES = {"gonogo": "reaction", "digit_span": "digit"}

def canonical_test_type(value: str) -> str:
    normalized = COGNITIVE_TYPE_ALIASES.get(value.strip().lower(), value.strip().lower())
    if normalized not in CANONICAL_COGNITIVE_TYPES:
        raise ValueError(f"unsupported cognitive test type: {value}")
    return normalized
```

It must also provide `normalize_result_json(test_type, value)` that preserves an existing canonical object and maps B legacy keys such as `avg_reaction_ms`, `correct_rate`, `duration_s`, `correct`, `wrong`, and `max_span` into the A canonical `raw_result` names and percentage units.

- [ ] **Step 4: Integrate normalization and seven-item reporting**

Validate/canonicalize on submission before writing the record. In `_extract_latest_cognitive_profile`, select `simple_reaction` separately, use it as the preferred reaction-speed source with `reaction` as fallback, keep `reaction` for false starts, and build latest items in canonical order. Do not alter existing medical/risk thresholds.

- [ ] **Step 5: Run backend and A mini-program tests**

Run:

```powershell
python -m pytest backend/tests/test_cognitive_contract.py -q
$tests = Get-ChildItem miniprogram/tests -Filter '*.test.js' | ForEach-Object FullName
node --test $tests
```

Expected: cognitive tests pass; all 76 A tests remain green.

- [ ] **Step 6: Document and commit the contract**

`docs/evidence/api-contract.md` must list method, path, auth role, request and response fields for auth, scale, cognitive, tracking, comprehensive report, AI, care, doctor and model routes. Mark the seven cognitive IDs as canonical.

```powershell
git add backend/app/services/cognitive_contract.py backend/tests/test_cognitive_contract.py backend/app/schemas/cognitive.py backend/app/api/routes/patient.py docs/evidence/api-contract.md
git commit -m "feat: synchronize seven cognitive task contract"
```

## Task 6: Persist uploads and make model provenance explicit

**Files:**
- Create: `backend/app/services/upload_storage.py`
- Create: `backend/tests/test_model_upload.py`
- Modify: `backend/app/api/routes/model_inference.py`
- Modify: `backend/app/models/upload.py`
- Modify: `backend/app/models/model_prediction.py`
- Modify: `backend/app/models/patient.py`
- Modify: `backend/app/schemas/model_inference.py`
- Modify: `backend/app/core/config.py`
- Modify: `backend/sql/init_mysql.sql`

- [ ] **Step 1: Write failing upload/provenance tests**

Tests must cover: empty upload rejected; non-`.1D`/`.csv` rejected; oversized upload rejected; valid file creates an `uploads` row with hash, size, safe stored name and status; real inference writes `source_type=fmri_hgst`; unavailable real model returns 503 without silently calling Mock; Mock writes `source_type=mock`, `is_demo=true`, and a warning that it is not a diagnosis.

- [ ] **Step 2: Run the tests and verify failure**

Run `python -m pytest backend/tests/test_model_upload.py -q`.

Expected: failures because the route currently does not persist `Upload` and the response has no explicit demonstration flag/upload ID.

- [ ] **Step 3: Implement safe upload storage**

`upload_storage.py` must enforce `UPLOAD_MAX_BYTES`, accept only `.1d` and `.csv`, compute SHA-256, create `backend/uploads/<uuid><suffix>`, write bytes only after validation, and return an immutable metadata object. The configured upload root must be resolved and checked so the final file remains under that root.

- [ ] **Step 4: Link uploads to predictions**

Add nullable `upload_id` to `ModelPrediction`, relationships on `Upload`, `ModelPrediction`, and `Patient`, and matching MySQL DDL. For a real request: create status `uploaded`, run inference, set status `completed` and create the prediction; on an inference exception set status `failed` with a concise note before returning the mapped error.

- [ ] **Step 5: Make response provenance explicit**

Add `upload_id: int | None`, `is_demo: bool`, and `disclaimer: str` to the prediction response. `predict_mock` must always set `is_demo=True`; `predict_fmri` must set `is_demo=False`. No route automatically falls back from real inference to Mock.

- [ ] **Step 6: Run tests and commit**

Run `python -m pytest backend/tests/test_model_upload.py -q` and expect all tests to pass.

```powershell
git add backend/app/services/upload_storage.py backend/tests/test_model_upload.py backend/app/api/routes/model_inference.py backend/app/models/upload.py backend/app/models/model_prediction.py backend/app/models/patient.py backend/app/schemas/model_inference.py backend/app/core/config.py backend/sql/init_mysql.sql
git commit -m "feat: persist uploads and expose model provenance"
```

## Task 7: Make demo seeding idempotent and contract-correct

**Files:**
- Create: `backend/tests/test_seed_idempotency.py`
- Modify: `backend/scripts/seed_demo_data.py`

- [ ] **Step 1: Write a failing two-run seed test**

On a fresh temporary SQLite database, call `seed_demo_data()` twice. Assert exactly three demo users, two patients, one current scale per patient, seven current cognitive records per patient, fourteen tracking rows per patient, two imaging rows per patient, one model prediction per patient, and no duplicate `(patient_id, day_index)` tracking keys.

- [ ] **Step 2: Run and verify the known failure**

Run `python -m pytest backend/tests/test_seed_idempotency.py -q`.

Expected before implementation: the second call fails on tracking uniqueness or duplicates child records.

- [ ] **Step 3: Implement deterministic replacement for demo-owned child rows**

Keep user/patient upsert behavior. Before adding sample results for each known demo patient, delete only that demo patient's existing demo scale, cognitive, tracking, imaging and Mock prediction rows, flush, then insert the canonical sample set. Use `normalize_result_json` for all seven cognitive payloads and include `finished_at`, `test_name`, `status_text`, `metrics`, and `raw_result`.

- [ ] **Step 4: Run twice and verify stable counts**

Run the focused test, then run the module twice against a disposable database.

Expected: both commands exit 0 and the second run reports stable counts rather than growth.

- [ ] **Step 5: Commit**

```powershell
git add backend/tests/test_seed_idempotency.py backend/scripts/seed_demo_data.py
git commit -m "fix: make demo seed repeatable and report-compatible"
```

## Task 8: Verify the A mini-program against B's API contract

**Files:**
- Create: `miniprogram/tests/backend-contract.test.js`
- Modify only if failing: `miniprogram/utils/request.js`
- Modify only if failing: `miniprogram/utils/report-data.js`
- Modify only if failing: individual page submit adapters under `miniprogram/pages/*/index.js`

- [ ] **Step 1: Write a failing static contract test**

The Node test must load A request/page sources and assert that active flows use B paths under `/api/v1`: `/auth/register`, `/auth/login`, `/auth/me`, `/patient/submit_scale`, `/patient/submit_cognitive_test`, `/patient/submit_daily_log`, `/patient/dashboard_status`, `/patient/comprehensive_report`, `/ai/chat`, and care routes. It must assert all seven page submitters emit canonical IDs and `{test_type, result_json}`.

- [ ] **Step 2: Run the test to identify real mismatches**

Run `node --test miniprogram/tests/backend-contract.test.js`.

Expected: failures list only actual route/field mismatches; the test must not require UI redesign.

- [ ] **Step 3: Apply the smallest adapters**

Fix paths in `request.js` when the mismatch is global. Fix field mapping in `report-data.js` when the server response differs from local report input. Touch a page submitter only when that page emits a noncanonical ID or result shape. Preserve A navigation, styles, Canvas implementation and storage keys.

- [ ] **Step 4: Run all mini-program tests**

Run all `miniprogram/tests/*.test.js`.

Expected: at least 77 tests pass, zero fail.

- [ ] **Step 5: Commit**

```powershell
git add miniprogram/tests/backend-contract.test.js miniprogram/utils/request.js miniprogram/utils/report-data.js miniprogram/pages
git commit -m "fix: align A mini-program with B backend contract"
```

## Task 9: Separate active doctor Web from legacy patient Web safely

**Files:**
- Create: `tools/web_dependency_audit.py`
- Create: `tests/test_web_dependency_audit.py`
- Create: `docs/evidence/web-dependency-report.json`
- Create: `doctor-web/README.md`
- Move after audit: active doctor HTML/CSS/JS into `doctor-web/`
- Move after audit: superseded patient HTML into `archive/legacy-patient-web/`

- [ ] **Step 1: Write dependency-audit tests**

Tests must create temporary HTML/CSS/JS fixtures and assert the audit extracts local `href`, `src`, fetch/XHR paths and CSS `url(...)`, ignores HTTP/data/mail links, resolves relative paths, and reports missing local targets.

- [ ] **Step 2: Run and verify failure**

Run `python -m unittest tests.test_web_dependency_audit -v`.

Expected: fail because the audit tool does not yet exist.

- [ ] **Step 3: Implement the audit tool**

The CLI accepts `--root` and `--output`. It scans tracked `.html`, `.css`, and `.js`, returns sorted JSON objects with `source`, `reference`, `resolved_target`, `exists`, and `kind`, and exits 1 when an active page has a missing local dependency.

- [ ] **Step 4: Generate the real report before moving anything**

Run:

```powershell
python tools/web_dependency_audit.py --root . --output docs/evidence/web-dependency-report.json
```

Classify doctor pages (`doctor_*`, `dac_dashboard`, `security_encryption`, model/visualization pages and their referenced assets) as active. Classify `patient_*` and duplicate patient-oriented root pages as legacy only when no active doctor page or backend static route references them.

- [ ] **Step 5: Move pages and repair relative references**

Use `git mv` for proven active doctor assets into `doctor-web/` and superseded patient pages into `archive/legacy-patient-web/`. Keep shared assets with the active doctor Web or duplicate only small immutable assets when both archive and active pages require them. Update backend static paths and HTML navigation links.

- [ ] **Step 6: Re-run audit and smoke checks**

Run the audit again and expect no missing active dependency. Start a local static server and request every active HTML path; expect HTTP 200 for HTML/CSS/JS resources.

- [ ] **Step 7: Commit**

```powershell
git add doctor-web archive tools/web_dependency_audit.py tests/test_web_dependency_audit.py docs/evidence/web-dependency-report.json backend
git commit -m "refactor: separate doctor web from legacy patient pages"
```

## Task 10: Produce one reproducible setup and operating guide

**Files:**
- Modify: `README.md`
- Modify: `backend/README.md`
- Modify: `backend/sql/init_mysql.sql`
- Move: historical progress/status documents into `docs/history/`
- Create: `docs/evidence/manual-acceptance.md`

- [ ] **Step 1: Write a documentation verification test**

Extend `tests/test_repository_cleanliness.py` to assert README commands reference existing files, `.env.example` lists every environment variable read by `backend/app/core/config.py`, and no active guide references `.venv/Scripts/python.exe` from a source directory or the old `E:\Python\py3112` path.

- [ ] **Step 2: Run and verify documentation failures**

Run `python -m unittest tests.test_repository_cleanliness -v`.

Expected: fail on stale paths or incomplete environment documentation.

- [ ] **Step 3: Write the operating guide**

Root README must include: component ownership, Python environment creation, dependency installation, copying `.env.example` to `.env`, SQLite quick start, MySQL initialization, database seed, backend start, API docs/health URLs, mini-program server settings, doctor Web startup, real model prerequisites, explicit Mock warning, test commands and manual acceptance limits.

- [ ] **Step 4: Archive stale documents**

Move old progress/verification documents that describe A-only or B-only state into `docs/history/`; add a banner stating their source and that they are not the current runbook.

- [ ] **Step 5: Verify and commit**

Run documentation/cleanliness tests and `git diff --check`, expect success.

```powershell
git add README.md backend/README.md backend/sql/init_mysql.sql docs/history docs/evidence/manual-acceptance.md tests/test_repository_cleanliness.py
git commit -m "docs: add reproducible AB merge runbook"
```

## Task 11: Run complete automated verification and record evidence

**Files:**
- Create: `docs/evidence/verification-report.md`
- Modify as defects require: only files already owned by Tasks 3-10

- [ ] **Step 1: Run mini-program verification**

Run all mini-program Node tests, parse `miniprogram/app.json`, verify every registered page has `.js`, `.json`, `.wxml`, `.wxss`, and run `node --check` for every mini-program `.js` file.

Expected: at least 77 tests pass, 21 pages complete, all JSON/JavaScript valid.

- [ ] **Step 2: Run backend verification**

Run `python -m pytest backend/tests -q`, `python -m compileall -q backend findviz`, initialize a fresh SQLite database, seed twice, start Uvicorn, and request `/`, `/api/v1/health`, and `/docs`.

Expected: all tests pass; both seeds succeed; three HTTP requests return 200.

- [ ] **Step 3: Run contract and Web verification**

Run `node --test miniprogram/tests/backend-contract.test.js`, the Web dependency audit, and static resource smoke checks.

Expected: all pass and no active local dependency is missing.

- [ ] **Step 4: Run cleanliness and sensitive-data verification**

Run `tools/merge/verify_clean_tree.ps1`, inspect `git status --short`, and scan tracked text for private keys, tokens, passwords, source absolute paths and medical/patient identifiers.

Expected: no prohibited artifact or secret; absolute source paths occur only in provenance evidence.

- [ ] **Step 5: Record exact evidence**

`docs/evidence/verification-report.md` must include date, commit, commands, exit status, test totals, database counts, HTTP results, unresolved external/manual checks, and a statement that automated success is not medical validation.

- [ ] **Step 6: Commit verification evidence**

```powershell
git add docs/evidence/verification-report.md
git commit -m "test: record AB merge verification evidence"
```

## Task 12: Deliver the third directory without overwriting either source

**Files:**
- Create outside the work repository only after approval: `C:\Users\Lenovo\Desktop\源码-AB合并版\`
- Create: `docs/evidence/delivery-manifest.json`

- [ ] **Step 1: Confirm the destination does not exist**

Run `Test-Path -LiteralPath 'C:\Users\Lenovo\Desktop\源码-AB合并版'`.

Expected: `False`. If `True`, stop; do not delete, merge, rename or overwrite it.

- [ ] **Step 2: Create a final delivery manifest**

Inventory tracked delivery files, commit ID and SHA-256 hashes into `docs/evidence/delivery-manifest.json`; exclude only `.git` from the portable copy if the user requests a source-only package. Default delivery includes `.git` so history remains auditable.

- [ ] **Step 3: Copy the isolated repository to the new desktop directory**

Use a copy operation whose source is the isolated work repository and whose destination is the exact new directory. Never use either original directory as the destination and never use a wildcard destination.

- [ ] **Step 4: Verify the delivered copy independently**

From the desktop copy, verify HEAD, clean Git status, delivery manifest hashes, mini-program tests, backend focused tests, and absence of excluded artifacts.

Expected: delivered HEAD equals the isolated work repository, tests pass, and both copies have clean status.

- [ ] **Step 5: Recheck source protection and finalize**

Regenerate A/B read-only inventories and compare them with Task 1 manifests. Report file-content differences, if any, before claiming protection. Commit the delivery manifest in the isolated repository and copy that final commit to the desktop directory.

```powershell
git add docs/evidence/delivery-manifest.json
git commit -m "chore: finalize AB merge delivery manifest"
```

Expected: A and B source content manifests are unchanged; the only new deliverable is `源码-AB合并版`.

## Execution checkpoints

- Checkpoint A, after Task 2: A and B source snapshots are independently committed; A's mini-program still passes all tests.
- Checkpoint B, after Task 5: backend starts on a temporary SQLite database and all seven cognitive tasks round-trip.
- Checkpoint C, after Task 8: A mini-program and B backend contract tests pass together.
- Checkpoint D, after Task 10: doctor Web is active, old patient Web is archived, and setup is reproducible.
- Checkpoint E, after Task 12: automated evidence and the independent desktop delivery both verify successfully.

The user has already requested independent inline completion, so execution uses `superpowers:executing-plans` in the current isolated repository. No subagent dispatch is used.
