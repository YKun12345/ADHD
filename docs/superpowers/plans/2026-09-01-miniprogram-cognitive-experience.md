# 小程序认知体验优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 缩短重复型认知任务、加入低干扰分节休息与差异化主题，并把 AI 助手升级为可爱宠物形象。

**Architecture:** 试次数与小节参数集中在 `cognitive-config.js`；通用休息判定放在独立的 `cognitive-experience.js`，页面只负责切换 `break` 阶段。视觉主题在各页面 WXSS 内覆盖共用认知样式；AI 宠物作为独立组件复用。

**Tech Stack:** 微信小程序 WXML/WXSS/CommonJS、Node.js 内置测试运行器。

---

### Task 1: 精简协议与休息判定

**Files:**
- Create: `miniprogram/utils/cognitive-experience.js`
- Modify: `miniprogram/utils/cognitive-config.js`
- Test: `miniprogram/tests/cognitive-config.test.js`
- Test: `miniprogram/tests/cognitive-experience.test.js`

- [ ] 先写失败测试，断言长任务上限为 60、各条件可整除，并断言休息只在非末尾小节边界触发。
- [ ] 运行 `node --test miniprogram/tests/cognitive-config.test.js miniprogram/tests/cognitive-experience.test.js`，预期因旧配置和缺少模块而失败。
- [ ] 实现精简配置及 `getSectionState(completed, total, blockSize)`。
- [ ] 重跑测试，预期全部通过。
- [ ] 只检查本地差异，不提交、不上传。

### Task 2: 长任务分节休息

**Files:**
- Modify: `miniprogram/pages/cognitive/index.js`
- Modify: `miniprogram/pages/cognitive/index.wxml`
- Modify: `miniprogram/pages/stroop/index.js`
- Modify: `miniprogram/pages/stroop/index.wxml`
- Modify: `miniprogram/pages/flanker/index.js`
- Modify: `miniprogram/pages/flanker/index.wxml`
- Modify: `miniprogram/pages/nback/index.js`
- Modify: `miniprogram/pages/nback/index.wxml`
- Test: `miniprogram/tests/cognitive-page.test.js`
- Test: `miniprogram/tests/stroop-page.test.js`
- Test: `miniprogram/tests/new-cognitive-pages.test.js`

- [ ] 先写失败测试，模拟完成一个小节并断言页面进入 `break`，且 `continueSection()` 后从下一试次继续。
- [ ] 运行相关页面测试，确认因缺少休息逻辑失败。
- [ ] 在四个页面接入统一休息判定、休息卡片和“继续下一节”按钮。
- [ ] 运行相关页面测试，预期全部通过。
- [ ] 只检查本地差异，不提交、不上传。

### Task 3: 视觉主题与按钮居中

**Files:**
- Modify: `miniprogram/pages/cognitive-task.wxss`
- Modify: `miniprogram/pages/cognitive/index.wxss`
- Modify: `miniprogram/pages/simple-reaction/index.wxss`
- Modify: `miniprogram/pages/stroop/index.wxss`
- Modify: `miniprogram/pages/trail/index.wxss`
- Modify: `miniprogram/pages/flanker/index.wxss`
- Modify: `miniprogram/pages/nback/index.wxss`
- Modify: `miniprogram/pages/digit-span/index.wxss`
- Modify: 对应 WXML 的主题类和精简版说明
- Test: `miniprogram/tests/new-cognitive-views.test.js`
- Test: `miniprogram/tests/ui-assessments.test.js`

- [ ] 先写失败视图契约，检查七个独立主题标识、相关按钮 Flex 双轴居中和精简版提示。
- [ ] 运行视图测试，确认旧样式不满足契约。
- [ ] 实现七个主题背景、休息卡片样式和统一按钮内容居中。
- [ ] 重跑视图测试，预期全部通过。
- [ ] 只检查本地差异，不提交、不上传。

### Task 4: AI 宠物组件

**Files:**
- Create: `miniprogram/components/ai-mascot/index.js`
- Create: `miniprogram/components/ai-mascot/index.json`
- Create: `miniprogram/components/ai-mascot/index.wxml`
- Create: `miniprogram/components/ai-mascot/index.wxss`
- Modify: `miniprogram/components/ai-copilot/index.json`
- Modify: `miniprogram/components/ai-copilot/index.wxml`
- Modify: `miniprogram/components/ai-copilot/index.wxss`
- Modify: `miniprogram/pages/ai-chat/index.json`
- Modify: `miniprogram/pages/ai-chat/index.wxml`
- Modify: `miniprogram/pages/ai-chat/index.wxss`
- Test: `miniprogram/tests/ai-mascot.test.js`
- Test: `miniprogram/tests/ui-ai.test.js`

- [ ] 先写失败测试，检查组件属性、三种状态、无障碍标签、减弱动画和两处接线。
- [ ] 运行 AI 相关测试，确认组件不存在且旧图标接线不满足契约。
- [ ] 实现 CSS 原生宠物“星仔”，接入悬浮助手和聊天页。
- [ ] 重跑 AI 相关测试，预期全部通过。
- [ ] 只检查本地差异，不提交、不上传。

### Task 5: 时长文案与全量验收

**Files:**
- Modify: `miniprogram/utils/cognitive-results.js`
- Modify: `miniprogram/pages/cognitive-center/index.wxml`
- Test: `miniprogram/tests/cognitive-results.test.js`

- [ ] 先写失败测试，断言精简后的估算总时长与卡片时长。
- [ ] 更新时长估算和中心页说明。
- [ ] 运行 `node --test miniprogram/tests/*.test.js`，预期 0 失败。
- [ ] 运行 `git diff --check` 与 `git status --short`，确认没有 `.env`、数据库、日志、密钥或原始目录改动。
- [ ] 保留所有修改在 `feature/a-cognitive-experience` 本地分支，不提交、不推送、不上传。
