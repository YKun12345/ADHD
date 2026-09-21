# Patient Web Migration and Mini-Program Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the unchanged legacy patient Web safely, remove only the mini-program simple reaction-time task, and make the draggable mini-program AI copilot respond reliably to taps.

**Architecture:** Add a narrowly mounted `patient-web/` static application that shares the existing `/api/v1` backend and database without exposing the repository root. Keep backend support for historical `simple_reaction` records while removing every active mini-program route and presentation of that task. Replace the copilot's stale cross-event tap-suppression flag with deterministic touch-end handling.

**Tech Stack:** FastAPI/Starlette `StaticFiles`, vanilla HTML/CSS/JavaScript, WeChat mini-program JavaScript/WXML/WXSS, Node test runner, pytest/unittest.

---

### Task 1: Specify the active patient Web boundary

**Files:**
- Modify: `tests/test_web_dependency_audit.py`
- Modify: `backend/tests/test_health.py`

- [ ] **Step 1: Write the failing structure and HTTP tests**

Extend the Web layout test with `active_web = ROOT / "patient-web"`. Assert that the six main patient pages exist in both `active_web` and `archive/legacy-patient-web`, and compare every archived `.html`, `.css`, and `.js` patient asset byte-for-byte after newline normalization:

```python
for archived in legacy_web.rglob("*"):
    if not archived.is_file() or archived.name == "README.md":
        continue
    relative = archived.relative_to(legacy_web)
    active = active_web / relative
    self.assertTrue(active.is_file(), relative.as_posix())
    self.assertEqual(
        archived.read_text(encoding="utf-8").replace("\r\n", "\n"),
        active.read_text(encoding="utf-8").replace("\r\n", "\n"),
        relative.as_posix(),
    )
```

Update the static-route backend test to require HTTP 200 for:

```python
for public_path in (
    "/doctor-web/login.html",
    "/patient-web/",
    "/patient-web/login.html",
    "/patient-web/patient_home.html",
    "/patient-web/js/api.js",
):
    assert client.get(public_path).status_code == 200
```

Retain 404 assertions for `/backend/app/main.py`, `/miniprogram/app.json`, and `/archive/legacy-patient-web/patient_home.html`.

- [ ] **Step 2: Run the tests and verify the expected failures**

Run:

```powershell
.venv\Scripts\python.exe -m unittest tests.test_web_dependency_audit.WebDependencyAuditTests.test_merge_layout_separates_active_doctor_and_legacy_patient_web -v
.venv\Scripts\python.exe -m pytest backend/tests/test_health.py::test_static_routes_expose_only_the_doctor_web -q
```

Expected: failures because `patient-web/` and its FastAPI mount do not exist.

- [ ] **Step 3: Commit the red tests**

```powershell
git add tests/test_web_dependency_audit.py backend/tests/test_health.py
git commit -m "test: specify active patient web boundary"
```

### Task 2: Restore the original patient Web as an active site

**Files:**
- Create: `patient-web/clinical_pathway.html`
- Create: `patient-web/patient_*.html`
- Create: `patient-web/css/style.css`
- Create: `patient-web/css/patient.css`
- Create: `patient-web/js/*.js` for the archived patient scripts
- Create: `patient-web/login.html`
- Create: `patient-web/css/login.css`
- Create: `patient-web/js/login.js`
- Create: `patient-web/index.html`
- Create: `patient-web/README.md`
- Modify: `backend/app/main.py`

- [ ] **Step 1: Copy the 26 archived patient assets mechanically**

Copy every file under `archive/legacy-patient-web/` except its archival `README.md` to the same relative path under `patient-web/`. Do not edit these copied files. Copy the original patient-capable `login.html`, `css/login.css`, and `js/login.js` from the adjacent original-source workspace (`../源码 - 副本`).

- [ ] **Step 2: Add an invisible entry redirect and active-site README**

Create `patient-web/index.html` as a same-directory redirect to `login.html`:

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=login.html">
  <title>知行合“医”</title>
</head>
<body><a href="login.html">进入患者网页版</a></body>
</html>
```

Document that `patient-web/` is active, while `archive/legacy-patient-web/` remains immutable provenance.

- [ ] **Step 3: Adapt only the researcher login destination**

In `patient-web/js/login.js`, preserve the patient destination and change only the researcher/DAC destinations to absolute active doctor-Web URLs:

```javascript
function getRedirectPath(role, user = null) {
    if (role === 'patient') return 'patient_home.html';
    if (user?.subrole === 'dac') return '/doctor-web/dac_dashboard.html';
    return '/doctor-web/doctor_analysis.html';
}
```

- [ ] **Step 4: Mount only the active patient Web directory**

Add this mount to `backend/app/main.py` alongside the doctor Web mount:

```python
app.mount(
    "/patient-web",
    StaticFiles(directory=str(BASE_DIR / "patient-web"), html=True),
    name="patient_web",
)
```

Do not add a root-directory static mount. Add `patient_web: "/patient-web/"` and `doctor_web: "/doctor-web/"` to the root JSON response.

- [ ] **Step 5: Run the focused tests and verify green**

Run:

```powershell
.venv\Scripts\python.exe -m unittest tests.test_web_dependency_audit.WebDependencyAuditTests.test_merge_layout_separates_active_doctor_and_legacy_patient_web -v
.venv\Scripts\python.exe -m pytest backend/tests/test_health.py::test_static_routes_expose_only_the_doctor_web -q
```

Expected: both pass; private repository paths remain 404.

- [ ] **Step 6: Commit the active patient Web**

```powershell
git add patient-web backend/app/main.py tests/test_web_dependency_audit.py backend/tests/test_health.py
git commit -m "feat: restore secure patient web entry"
```

### Task 3: Specify removal of the simple reaction-time mini-program task

**Files:**
- Create: `miniprogram/tests/simple-reaction-removal.test.js`

- [ ] **Step 1: Write a failing removal contract**

The test must parse `miniprogram/app.json`, import `TASK_ORDER`, `TEST_DEFINITIONS`, and `buildCognitiveSummary`, and assert:

```javascript
assert.equal(app.pages.includes('pages/simple-reaction/index'), false)
assert.equal(TASK_ORDER.includes('simple_reaction'), false)
assert.equal(TEST_DEFINITIONS.some((item) => item.id === 'simple_reaction'), false)
assert.equal(buildCognitiveSummary({}).totalCount, 6)
assert.equal(fs.existsSync(path.join(ROOT, 'pages', 'simple-reaction')), false)
assert.equal(fs.existsSync(path.join(ROOT, 'utils', 'simple-reaction-test.js')), false)
```

Also assert that the remaining order is exactly:

```javascript
['reaction', 'stroop', 'flanker', 'nback', 'trail', 'digit']
```

- [ ] **Step 2: Run the test and verify red**

Run:

```powershell
node --test miniprogram/tests/simple-reaction-removal.test.js
```

Expected: failure because the page, task definition, and configuration still exist.

- [ ] **Step 3: Commit the red test**

```powershell
git add miniprogram/tests/simple-reaction-removal.test.js
git commit -m "test: require simple reaction task removal"
```

### Task 4: Remove only simple reaction-time from the active mini-program

**Files:**
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/pages/cognitive-center/index.js`
- Modify: `miniprogram/pages/cognitive-center/index.wxml`
- Modify: `miniprogram/utils/cognitive-config.js`
- Modify: `miniprogram/utils/cognitive-results.js`
- Modify: `miniprogram/utils/cognitive-page-support.js`
- Modify: `miniprogram/utils/report-data.js`
- Modify: `miniprogram/utils/ai-copilot.js`
- Modify: `miniprogram/utils/page-guide-content.js`
- Modify: relevant files under `miniprogram/tests/`
- Delete: `miniprogram/pages/simple-reaction/index.js`
- Delete: `miniprogram/pages/simple-reaction/index.json`
- Delete: `miniprogram/pages/simple-reaction/index.wxml`
- Delete: `miniprogram/pages/simple-reaction/index.wxss`
- Delete: `miniprogram/utils/simple-reaction-test.js`
- Delete: `miniprogram/tests/simple-reaction-test.test.js`
- Delete: `miniprogram/tests/cognitive-randomization.test.js`

- [ ] **Step 1: Remove the active route, task configuration, card, and report definition**

Remove only `simple_reaction` entries. Set the active task order to:

```javascript
const TASK_ORDER = Object.freeze([
  'reaction', 'stroop', 'flanker', 'nback', 'trail', 'digit'
])
```

Change the first cognitive group to `taskIds: ['reaction']` and update its duration. Change all active user-facing counts from seven to six and compute partial progress against `totalCount` rather than a literal `7`.

- [ ] **Step 2: Remove the obsolete page and its dedicated implementation/tests**

Delete only the files listed above. Keep backend compatibility code and tests. Keep stale `pending_simple_reaction_result` cleanup in `session-privacy.js` so upgraded clients can remove old local data.

- [ ] **Step 3: Update existing mini-program test expectations**

Remove `simple_reaction` from page lists, AI page keys, guide lists, battery sequences, report fixtures, UI theme lists, and backend-contract utility checks. Update totals, indexes, durations, and Chinese copy from seven to six. Do not weaken assertions for the remaining tasks.

- [ ] **Step 4: Run removal and cognitive suites**

Run:

```powershell
node --test miniprogram/tests/simple-reaction-removal.test.js miniprogram/tests/cognitive-*.test.js miniprogram/tests/report-data.test.js miniprogram/tests/ai-copilot*.test.js miniprogram/tests/guide-state.test.js miniprogram/tests/backend-contract.test.js
```

Expected: all pass, with six active cognitive tasks.

- [ ] **Step 5: Commit the task removal**

```powershell
git add miniprogram
git commit -m "feat: remove simple reaction mini-program task"
```

### Task 5: Reproduce and fix the draggable AI copilot tap bug

**Files:**
- Modify: `miniprogram/tests/ai-copilot-component.test.js`
- Modify: `miniprogram/components/ai-copilot/index.js`
- Modify: `miniprogram/components/ai-copilot/index.wxml`

- [ ] **Step 1: Replace the synthetic-tap assumption in the test with the real failing sequence**

After a drag, do not call `togglePanel()` to simulate a synthetic tap. Finish the drag without opening, then perform the next real touch and require it to open immediately:

```javascript
component.handleDragStart({ touches: [{ clientX: 330, clientY: 730 }] })
component.handleDragMove({ touches: [{ clientX: 100, clientY: 350 }] })
component.handleDragEnd()
assert.equal(component.data.expanded, false)
component.handleDragStart({ touches: [{ clientX: 20, clientY: 410 }] })
component.handleDragEnd()
assert.equal(component.data.expanded, true, '拖动后的第一次真实轻触必须立即打开')
```

Add a touch-cancel assertion:

```javascript
component.closePanel()
component.handleDragStart({ touches: [{ clientX: 20, clientY: 410 }] })
component.handleDragCancel()
assert.equal(component.data.expanded, false)
```

Require WXML to contain `catchtouchcancel="handleDragCancel"` and no `bindtap="togglePanel"`.

- [ ] **Step 2: Run the component test and verify red**

Run:

```powershell
node --test miniprogram/tests/ai-copilot-component.test.js
```

Expected: failure because a touch end does not open the panel and `handleDragCancel` does not exist.

- [ ] **Step 3: Implement deterministic touch completion**

In `handleDragEnd`, clear drag state, then call `togglePanel()` when `_dragMoved` is false. For real drags, retain snap/storage behavior and do not set `_suppressNextTap`. Add `handleDragCancel()` that clears `_dragTouchStart`, `_dragPositionStart`, and `_dragMoved` without opening. Remove the trigger's `bindtap` and bind touch cancel to the new method.

- [ ] **Step 4: Run the component and related AI tests**

Run:

```powershell
node --test miniprogram/tests/ai-copilot-component.test.js miniprogram/tests/ai-copilot-position.test.js miniprogram/tests/ai-copilot.test.js miniprogram/tests/ai-copilot-wiring.test.js
```

Expected: all pass; drag behavior, navigation locking, and placement tests remain intact.

- [ ] **Step 5: Commit the AI copilot fix**

```powershell
git add miniprogram/components/ai-copilot miniprogram/tests/ai-copilot-component.test.js
git commit -m "fix: make draggable AI copilot taps reliable"
```

### Task 6: Update active documentation and Web dependency evidence

**Files:**
- Modify: `README.md`
- Modify: `backend/README.md`
- Modify: `backend/docs/后端技术实现.md`
- Modify: `docs/evidence/api-contract.md`
- Modify: `docs/evidence/manual-acceptance.md`
- Modify: `docs/evidence/web-dependency-report.json`
- Create: `patient-web/README.md`

- [ ] **Step 1: Document the active patient Web and six-task mini-program**

Replace statements saying patients must use only the mini-program. Document `/patient-web/`, `/doctor-web/`, the shared account/database model, six active mini-program cognitive tasks, and historical `simple_reaction` backend compatibility.

- [ ] **Step 2: Regenerate the active Web dependency report**

Run:

```powershell
.venv\Scripts\python.exe tools/web_dependency_audit.py --root . --output docs/evidence/web-dependency-report.json --exclude archive --exclude miniprogram --exclude findviz/templates --exclude findviz/static/js/main.js --exclude HGST-main
```

Expected: `missing_count=0`, including `patient-web/` references.

- [ ] **Step 3: Run documentation and Web audits**

Run:

```powershell
.venv\Scripts\python.exe -m unittest tests.test_web_dependency_audit tests.test_repository_cleanliness -v
```

Expected: all pass.

- [ ] **Step 4: Commit documentation and evidence**

```powershell
git add README.md backend/README.md backend/docs docs/evidence patient-web/README.md
git commit -m "docs: publish patient web and six-task workflow"
```

### Task 7: Full regression and security verification

**Files:**
- Verify only; fix only failures caused by this plan.

- [ ] **Step 1: Run all mini-program tests**

```powershell
node --test miniprogram/tests/*.test.js
```

Expected: zero failures and no test references to the removed page or utility.

- [ ] **Step 2: Run all backend tests**

```powershell
.venv\Scripts\python.exe -m pytest backend/tests -q
```

Expected: zero failures; historical `simple_reaction` compatibility tests pass.

- [ ] **Step 3: Run repository, Web, lint, and compilation checks**

```powershell
.venv\Scripts\python.exe -m unittest tests.test_web_dependency_audit tests.test_repository_cleanliness tests.test_delivery_manifest -v
.venv\Scripts\python.exe -m ruff check backend
.venv\Scripts\python.exe -m compileall -q backend findviz
git diff --check
```

Expected: zero failures or lint errors.

- [ ] **Step 4: Verify tracked changes and sensitive-path boundaries**

Review `git status --short`, `git diff --stat`, and the final HTTP test output. Confirm the pre-existing `.codex-ppt-build/` directory remains untouched and untracked.

- [ ] **Step 5: Commit any verification-only corrections**

If verification required scoped corrections, commit only those files with:

```powershell
git add <exact-files>
git commit -m "test: complete patient web migration verification"
```
