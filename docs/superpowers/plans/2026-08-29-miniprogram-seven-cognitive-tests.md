# Miniprogram Seven Cognitive Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 B 端文件的前提下，把患者小程序扩展为成人/儿童自适应的七项认知测试、完整评估流程和七项本地报告。

**Architecture:** 五个新增任务使用独立页面和纯逻辑模块，现有 Go/No-Go 与 Stroop 保持路由兼容并升级。共享配置、结果汇总和完整评估状态模块统一七项定义、本地缓存、同步状态与任务顺序。所有页面继续调用现有通用认知提交接口，失败时本地保留。

**Tech Stack:** 微信小程序原生 WXML/WXSS/CommonJS、Node.js `assert` 测试、现有 `registerPatientPage` 与 `API.Patient.submitCognitiveTest`。

---

### Task 1: 七项共享配置、结果与完整评估状态

**Files:**
- Create: `miniprogram/utils/cognitive-config.js`
- Create: `miniprogram/utils/cognitive-battery.js`
- Create: `miniprogram/tests/cognitive-config.test.js`
- Create: `miniprogram/tests/cognitive-battery.test.js`
- Modify: `miniprogram/utils/cognitive-results.js`
- Modify: `miniprogram/tests/cognitive-results.test.js`

- [ ] **Step 1: Write failing tests** verifying adult/child parameter selection, seven stable IDs and routes, old two-result cache migration, 0/7 through 7/7 progress, battery start/resume/next-task completion, and patient-scoped battery state.
- [ ] **Step 2: Run tests to verify RED:** `node miniprogram/tests/cognitive-config.test.js; node miniprogram/tests/cognitive-battery.test.js; node miniprogram/tests/cognitive-results.test.js`. Expected failures mention missing modules or `2 !== 7`.
- [ ] **Step 3: Implement minimal pure modules** exporting `resolveAgeGroup(user)`, `getTaskConfig(taskId, ageGroup)`, `TEST_DEFINITIONS`, `buildCognitiveSummary(value)`, `createBatteryState(patientKey)`, `completeBatteryTask(state, taskId)`, and `nextBatteryTask(state)`.
- [ ] **Step 4: Run the three tests and verify GREEN.**
- [ ] **Step 5: Commit:** `git add miniprogram/utils/cognitive-config.js miniprogram/utils/cognitive-battery.js miniprogram/utils/cognitive-results.js miniprogram/tests/cognitive-config.test.js miniprogram/tests/cognitive-battery.test.js miniprogram/tests/cognitive-results.test.js && git commit -m "feat(miniprogram): model seven cognitive tasks"`.

### Task 2: 简单反应时任务

**Files:**
- Create: `miniprogram/utils/simple-reaction-test.js`
- Create: `miniprogram/tests/simple-reaction-test.test.js`
- Create: `miniprogram/pages/simple-reaction/index.js`
- Create: `miniprogram/pages/simple-reaction/index.json`
- Create: `miniprogram/pages/simple-reaction/index.wxml`
- Create: `miniprogram/pages/simple-reaction/index.wxss`
- Create: `miniprogram/tests/simple-reaction-page.test.js`
- Create: `miniprogram/tests/simple-reaction-view.test.js`

- [ ] **Step 1: Write failing pure-logic tests** for stratified 1000–2500 ms delays, early taps, valid responses, omissions, median/mean/variability metrics, quality flags, and `simple_reaction` payload.
- [ ] **Step 2: Verify RED:** `node miniprogram/tests/simple-reaction-test.test.js` fails because the module is absent.
- [ ] **Step 3: Implement the pure model** with `buildDelaySequence`, `evaluateReactionTrial`, `summarizeReactionTrials`, and `buildSimpleReactionPayload`.
- [ ] **Step 4: Verify model GREEN.**
- [ ] **Step 5: Write failing controller/view tests** for intro, practice, formal progress, timer cleanup, `onHide` interruption, local-first save, retry, result metrics and disclaimer.
- [ ] **Step 6: Verify page/view RED.**
- [ ] **Step 7: Implement the page** using registered timer IDs, an answer lock and existing patient request wrapper; provide accessible target text and no production-only emoji.
- [ ] **Step 8: Verify all three tests GREEN and commit** with message `feat(miniprogram): add simple reaction task`.

### Task 3: 连线 A/B 任务

**Files:**
- Create: `miniprogram/utils/trail-test.js`
- Create: `miniprogram/tests/trail-test.test.js`
- Create: `miniprogram/pages/trail/index.js`
- Create: `miniprogram/pages/trail/index.json`
- Create: `miniprogram/pages/trail/index.wxml`
- Create: `miniprogram/pages/trail/index.wxss`
- Create: `miniprogram/tests/trail-page.test.js`
- Create: `miniprogram/tests/trail-view.test.js`

- [ ] **Step 1: Write RED tests** for child/adult A/B sequences, deterministic minimum-spacing layout, correct next node, errors/corrections, stage and total elapsed time, interrupted/unfinished quality, and `trail` payload.
- [ ] **Step 2: Implement and verify pure functions** `buildTrailSequence`, `createTrailLayout`, `evaluateTrailTap`, `summarizeTrailStages`, and `buildTrailPayload`.
- [ ] **Step 3: Write RED controller/view tests** covering A practice, A formal, rest, B practice, B formal, node taps, line segments, restart, storage and sync.
- [ ] **Step 4: Implement the page** with absolute-positioned nodes and Canvas path drawing; clear canvas/timers on lifecycle changes.
- [ ] **Step 5: Run tests GREEN and commit** with message `feat(miniprogram): add trail making task`.

### Task 4: Flanker 任务

**Files:**
- Create: `miniprogram/utils/flanker-test.js`
- Create: `miniprogram/tests/flanker-test.test.js`
- Create: `miniprogram/pages/flanker/index.js`
- Create: `miniprogram/pages/flanker/index.json`
- Create: `miniprogram/pages/flanker/index.wxml`
- Create: `miniprogram/pages/flanker/index.wxss`
- Create: `miniprogram/tests/flanker-page.test.js`
- Create: `miniprogram/tests/flanker-view.test.js`

- [ ] **Step 1: Write RED tests** for balanced congruent/incongruent/neutral conditions, balanced target direction, answer scoring, omission/fast-response flags, condition medians, conflict effect and `flanker` payload.
- [ ] **Step 2: Implement and verify** `buildFlankerTrials`, `evaluateFlankerTrial`, `summarizeFlankerTrials`, and `buildFlankerPayload`.
- [ ] **Step 3: Write RED page/view tests** for practice gate, formal blocks, response lock, left/right controls, rest, interruption, local save and retry.
- [ ] **Step 4: Implement the page**, run all Flanker tests GREEN and commit `feat(miniprogram): add flanker task`.

### Task 5: 空间 2-back 任务

**Files:**
- Create: `miniprogram/utils/nback-test.js`
- Create: `miniprogram/tests/nback-test.test.js`
- Create: `miniprogram/pages/nback/index.js`
- Create: `miniprogram/pages/nback/index.json`
- Create: `miniprogram/pages/nback/index.wxml`
- Create: `miniprogram/pages/nback/index.wxss`
- Create: `miniprogram/tests/nback-page.test.js`
- Create: `miniprogram/tests/nback-view.test.js`

- [ ] **Step 1: Write RED tests** for controlled 2-back target ratio, no triple-position repeats, match/non-match outcomes, hit/miss/false-alarm/correct-rejection counts, accuracy, corrected d-prime approximation, quality flags and `nback` payload.
- [ ] **Step 2: Implement and verify** `buildNBackTrials`, `evaluateNBackAnswer`, `summarizeNBackTrials`, and `buildNBackPayload`.
- [ ] **Step 3: Write RED controller/view tests** for ten practice trials, grid stimulus timing, two response buttons, formal blocks, response window, rest, interruption, save and retry.
- [ ] **Step 4: Implement the page**, run GREEN and commit `feat(miniprogram): add spatial nback task`.

### Task 6: 数字广度顺背/倒背

**Files:**
- Create: `miniprogram/utils/digit-span-test.js`
- Create: `miniprogram/tests/digit-span-test.test.js`
- Create: `miniprogram/pages/digit-span/index.js`
- Create: `miniprogram/pages/digit-span/index.json`
- Create: `miniprogram/pages/digit-span/index.wxml`
- Create: `miniprogram/pages/digit-span/index.wxss`
- Create: `miniprogram/tests/digit-span-page.test.js`
- Create: `miniprogram/tests/digit-span-view.test.js`

- [ ] **Step 1: Write RED tests** for non-repeating sequences, forward/backward expected answers, all configured lengths with two trials each, input/delete/submit behavior, per-direction spans, digit-level score and `digit` payload.
- [ ] **Step 2: Implement and verify** `buildDigitTrials`, `expectedDigitAnswer`, `evaluateDigitTrial`, `summarizeDigitTrials`, and `buildDigitSpanPayload`.
- [ ] **Step 3: Write RED page/view tests** for paced single-digit presentation, hidden recall phase, keypad, forward/backward transition, rest, interruption, save and retry.
- [ ] **Step 4: Implement the page**, run GREEN and commit `feat(miniprogram): add digit span task`.

### Task 7: 升级 Go/No-Go 与 Stroop 完整流程

**Files:**
- Modify: `miniprogram/utils/gonogo-test.js`
- Modify: `miniprogram/tests/gonogo-test.test.js`
- Modify: `miniprogram/pages/cognitive/index.js`
- Modify: `miniprogram/pages/cognitive/index.wxml`
- Modify: `miniprogram/pages/cognitive/index.wxss`
- Modify: `miniprogram/tests/cognitive-page.test.js`
- Modify: `miniprogram/tests/cognitive-view.test.js`
- Modify: `miniprogram/utils/stroop-test.js`
- Modify: `miniprogram/tests/stroop-test.test.js`
- Modify: `miniprogram/pages/stroop/index.js`
- Modify: `miniprogram/pages/stroop/index.wxml`
- Modify: `miniprogram/pages/stroop/index.wxss`
- Modify: `miniprogram/tests/stroop-page.test.js`
- Modify: `miniprogram/tests/stroop-view.test.js`

- [ ] **Step 1: Extend tests first** for age-group configurations, practice threshold, formal blocks, balanced conditions, median RT, quality fields, no formal feedback and schema version 2; verify failures are expected.
- [ ] **Step 2: Upgrade Go/No-Go** while preserving `test_type: reaction`, legacy storage keys and current UI component changes; run its focused tests GREEN.
- [ ] **Step 3: Upgrade Stroop** while preserving `test_type: stroop`, current UI component changes and legacy storage keys; run focused tests GREEN.
- [ ] **Step 4: Commit** only the existing two task files and tests with message `feat(miniprogram): expand inhibition task protocols`.

### Task 8: 七项认知中心、完整评估与路由

**Files:**
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/pages/cognitive-center/index.js`
- Modify: `miniprogram/pages/cognitive-center/index.json`
- Modify: `miniprogram/pages/cognitive-center/index.wxml`
- Modify: `miniprogram/pages/cognitive-center/index.wxss`
- Modify: `miniprogram/tests/cognitive-center-page.test.js`
- Modify: `miniprogram/tests/cognitive-center-view.test.js`
- Modify: `miniprogram/tests/ui-icon-system.test.js`
- Modify: `miniprogram/components/ui-icon/index.js`
- Modify: `miniprogram/components/ui-icon/index.wxml`
- Modify: `miniprogram/components/ui-icon/index.wxss`

- [ ] **Step 1: Write RED tests** for seven registered routes/cards, 0/7–7/7 copy, complete-assessment start/resume, remaining time, per-card icon mapping and navigation mode query.
- [ ] **Step 2: Extend the icon system** with five accessible code-native task icons, preserving the current no-emoji UI rule.
- [ ] **Step 3: Implement the center and route registration**, retaining the user's current `ui-nav`, glass surfaces and safe-area styling.
- [ ] **Step 4: Run focused tests GREEN and commit** `feat(miniprogram): add seven task cognitive center`.

### Task 9: 七项本地综合报告

**Files:**
- Modify: `miniprogram/utils/report-data.js`
- Modify: `miniprogram/tests/report-data.test.js`
- Modify: `miniprogram/pages/report/index.js`
- Modify: `miniprogram/pages/report/index.wxml`
- Modify: `miniprogram/tests/report-page.test.js`
- Modify: `miniprogram/tests/report-view.test.js`

- [ ] **Step 1: Write RED tests** for seven local cards, type-specific primary/secondary metrics, quality labels, server-first plus local supplementation, and service responses that omit `simple_reaction`.
- [ ] **Step 2: Extend report normalization and merge logic** without altering the current Canvas improvements or B's radar calculation.
- [ ] **Step 3: Update report view copy for seven items**, run focused tests GREEN and commit `feat(miniprogram): report seven cognitive results`.

### Task 10: A 端回归、文档与验收

**Files:**
- Modify: `项目任务与进度.md`
- Create: `docs/qa/2026-08-29-seven-cognitive-tests-device-checklist.md`

- [ ] **Step 1: Run every test:** PowerShell loop over `miniprogram/tests/*.test.js`; expected all exit 0.
- [ ] **Step 2: Run syntax and config checks:** `node --check` for every miniprogram JS file and `ConvertFrom-Json` for every miniprogram JSON file; expected no output/errors.
- [ ] **Step 3: Run `git diff --check`;** expected no whitespace errors.
- [ ] **Step 4: Update A progress and write true-device checks** for child/adult parameters, touch rhythm, Canvas/layout, background interruption, storage, offline retry and full battery resume.
- [ ] **Step 5: Review the final diff** and confirm no `backend/` or doctor web file changed.
- [ ] **Step 6: Commit** remaining A documentation and verification changes with message `docs: record seven cognitive tests delivery`.
