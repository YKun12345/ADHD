# Miniprogram Go/No-Go Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 D6 Go/No-Go 触摸测试、客观指标、离线待同步和首页入口。

**Architecture:** 纯逻辑模块负责试次与汇总，页面控制器负责时钟、定时器和微信 API。后端失败时保存明确的待同步结果，不修改 B 的接口。

**Tech Stack:** 原生小程序、CommonJS、Node `assert`、可注入/可替换计时器测试。

---

### Task 1: Go/No-Go 纯逻辑

**Files:**
- Create: `miniprogram/tests/gonogo-test.test.js`
- Create: `miniprogram/utils/gonogo-test.js`

- [x] 先测试 10 轮（6 GO、4 NO-GO）、五种判定、汇总和 payload，观察模块不存在红灯。
- [x] 实现 `TRIAL_SEQUENCE/evaluateTrial/summarizeTrials/buildCognitivePayload`。
- [x] 运行测试、语法检查并提交 `feat(miniprogram): add Go No-Go test model`。

### Task 2: 页面控制器与可控计时

**Files:**
- Create: `miniprogram/tests/cognitive-page.test.js`
- Create: `miniprogram/pages/cognitive/index.js`
- Create: `miniprogram/pages/cognitive/index.json`

- [x] 先用 fake `setTimeout/clearTimeout/Date.now` 测试启动、提前点击、GO 点击、NO-GO 超时、完成、同步失败待保存、重复启动和卸载清理。
- [x] 实现 `intro/waiting/stimulus/feedback/result` 阶段机和等待、响应、反馈三个定时器句柄。
- [x] 运行页面与纯逻辑测试，语法检查并提交 `feat(miniprogram): implement Go No-Go controller`。

### Task 3: 测试界面

**Files:**
- Create: `miniprogram/tests/cognitive-view.test.js`
- Create: `miniprogram/pages/cognitive/index.wxml`
- Create: `miniprogram/pages/cognitive/index.wxss`

- [x] 先测试说明、进度、GO/NO-GO 刺激、触摸区域、反馈、结果指标、同步状态和免责声明，观察文件不存在红灯。
- [x] 创建适合手机触摸的高对比测试区，禁用文本选择和重复按钮。
- [x] 运行视图与控制器测试并提交 `style(miniprogram): build Go No-Go test interface`。

### Task 4: 注册路由和首页入口

**Files:**
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/utils/home-dashboard.js`
- Modify: `miniprogram/tests/home-dashboard.test.js`
- Modify: `miniprogram/tests/home-page.test.js`
- Modify: `miniprogram/tests/cognitive-view.test.js`

- [x] 先要求认知任务和快捷入口可用并指向 `/pages/cognitive/index`，观察红灯。
- [x] 注册页面并为成人、儿童启用认知入口；未知患者类型保持锁定。
- [x] 回归后提交 `feat(miniprogram): enable Go No-Go entry`。

### Task 5: 全量验证和记录

**Files:**
- Modify: `项目任务与进度.md`
- Modify: `docs/superpowers/plans/2026-08-21-miniprogram-gonogo.md`

- [x] 运行全部小程序测试、全部 JavaScript 语法和 `git diff --check`。
- [x] D6 更新为 100%，记录提交、同步边界、测试数量和真机触摸待 D13 验收。
- [x] 提交记录并确认工作区干净。

## 计划自审

- 判定、控制器、视图、路由和记录分别测试与提交；
- 定时器生命周期和重复操作包含测试；
- 不依赖或修改 B 的实现；
- 离线结果明确标记待同步；
- 不输出医学诊断。
