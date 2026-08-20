# Miniprogram Stroop and Cognitive Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 D7 Stroop 颜色词测试、两项认知任务的本地汇总和统一入口。

**Architecture:** Stroop 纯逻辑、认知结果纯逻辑、页面控制器和视图分层。两个测试各自保存最近 payload，并复用 B 的通用认知提交契约。

**Tech Stack:** 原生微信小程序、CommonJS、Node `assert`、fake timers。

---

### Task 1: Stroop 与认知汇总纯逻辑

**Files:**
- Create: `miniprogram/tests/stroop-test.test.js`
- Create: `miniprogram/utils/stroop-test.js`
- Create: `miniprogram/tests/cognitive-results.test.js`
- Create: `miniprogram/utils/cognitive-results.js`
- Modify: `miniprogram/utils/gonogo-test.js`
- Modify: `miniprogram/tests/gonogo-test.test.js`

- [ ] 先测试固定 8 题、颜色判定、反应时、相容/冲突统计、payload、最近结果合并和 0/2—2/2 汇总，观察红灯。
- [ ] 实现两个纯逻辑模块，并为 Go/No-Go payload 补充报告元数据。
- [ ] 运行相关测试与语法检查，提交 `feat(miniprogram): model Stroop and cognitive summary`。

### Task 2: Stroop 页面控制器

**Files:**
- Create: `miniprogram/tests/stroop-page.test.js`
- Create: `miniprogram/pages/stroop/index.js`
- Create: `miniprogram/pages/stroop/index.json`

- [ ] 先用 fake `Date.now/setTimeout/clearTimeout` 测试加载、启动、作答、防重复、完整 8 题、本地保存、同步成功/失败、重试和卸载。
- [ ] 实现 `intro/testing/feedback/result` 状态机和独立待同步 key。
- [ ] 运行页面与纯逻辑测试，提交 `feat(miniprogram): implement Stroop controller`。

### Task 3: Stroop 视图

**Files:**
- Create: `miniprogram/tests/stroop-view.test.js`
- Create: `miniprogram/pages/stroop/index.wxml`
- Create: `miniprogram/pages/stroop/index.wxss`

- [ ] 先测试说明、颜色词、四个颜色按钮、进度、反馈、结果指标、同步状态与免责声明，观察文件不存在红灯。
- [ ] 实现高对比、非仅依赖色彩的手机界面，并确保按钮内容明确居中。
- [ ] 运行结构与控制器测试，提交 `style(miniprogram): build Stroop test interface`。

### Task 4: 认知中心与 D6 本地结果接入

**Files:**
- Create: `miniprogram/tests/cognitive-center-page.test.js`
- Create: `miniprogram/tests/cognitive-center-view.test.js`
- Create: `miniprogram/pages/cognitive-center/index.js`
- Create: `miniprogram/pages/cognitive-center/index.json`
- Create: `miniprogram/pages/cognitive-center/index.wxml`
- Create: `miniprogram/pages/cognitive-center/index.wxss`
- Modify: `miniprogram/pages/cognitive/index.js`
- Modify: `miniprogram/tests/cognitive-page.test.js`

- [ ] 先测试认知中心读取 0/2—2/2、本地结果卡、双任务导航和 Go/No-Go 完成后本地保存，观察红灯。
- [ ] 实现中心控制器与视图，并让 D6 结果先落本地再同步。
- [ ] 运行相关回归，提交 `feat(miniprogram): add cognitive test center`。

### Task 5: 路由、首页与全量验证

**Files:**
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/utils/home-dashboard.js`
- Modify: `miniprogram/tests/home-dashboard.test.js`
- Modify: `miniprogram/tests/home-page.test.js`
- Modify: `项目任务与进度.md`
- Modify: `docs/superpowers/plans/2026-08-21-miniprogram-stroop-summary.md`

- [ ] 先测试首页认知入口改为 `/pages/cognitive-center/index` 且两个新路由已注册，观察红灯。
- [ ] 更新路由与入口，运行全部测试、JavaScript 语法、JSON 和 `git diff --check`。
- [ ] D7 更新为 100%，记录接口/真机边界，提交记录并确认工作区干净。

## 计划自审

- 每层先红灯再实现；
- 复用现有页面，不破坏 D6；
- 本地汇总不生成医学诊断；
- 不修改 B 文件；
- 每个检查点精确暂存与提交。
