# 小程序认知减负与视觉分区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 精简七项认知任务并把两个容易产生重复感的反应任务缩到 20–25 题，去除 AI 宠物外圈，并为主要非计时页面建立不同的柔和背景主题。

**Architecture:** 题量继续由 `cognitive-config.js` 单点配置，页面控制器通过现有 `getSectionState` 自动获得单节行为。AI 改动只涉及可复用 Copilot 组件。视觉主题由各页面 WXSS 的根 `page` 或页面容器负责，计时任务核心区域不增加装饰。

**Tech Stack:** 微信小程序 WXML/WXSS/CommonJS，Node.js 内置测试运行器。

---

### Task 1: 固定短版认知协议

**Files:**
- Modify: `miniprogram/tests/cognitive-config.test.js`
- Modify: `miniprogram/tests/cognitive-page.test.js`
- Modify: `miniprogram/utils/cognitive-config.js`
- Modify: `miniprogram/utils/cognitive-results.js`
- Modify: `miniprogram/tests/cognitive-results.test.js`

- [ ] 先把配置测试期望改为 reaction 成人和儿童均为 25 题、simple_reaction 均为 20 题，blockSize 等于各自总题量，并断言练习题为 5/4、新协议为 `ultra-brief-mobile-v2`。
- [ ] 运行 `node --test miniprogram/tests/cognitive-config.test.js`，确认旧配置导致测试失败。
- [ ] 修改 `cognitive-config.js` 的正式题量、练习题量、blockSize、schemaVersion、protocolId 和 protocolLabel。
- [ ] 运行配置测试，确认通过。
- [ ] 在控制器测试中断言 Go/No-Go 完成第 20 题后继续测试而非进入休息。
- [ ] 运行 `node --test miniprogram/tests/cognitive-page.test.js`，确认旧 blockSize 导致测试失败。
- [ ] 通过单节配置使控制器测试通过，不添加页面特判。
- [ ] 把 Stroop/Flanker/2-back 改为 36/32/30 题并保留一次分段休息；适当降低练习题、成人连线节点和数字广度最高跨度。
- [ ] 把七项预计用时改为 2/2/3/4/3/3/6 分钟，总计改为 23 分钟，并按红绿循环更新结果测试。

### Task 2: 去除 AI 宠物外圈

**Files:**
- Modify: `miniprogram/tests/ui-ai.test.js`
- Modify: `miniprogram/components/ai-copilot/index.wxml`
- Modify: `miniprogram/components/ai-copilot/index.wxss`

- [ ] 在 UI 测试中断言 WXML 不包含 `ai-copilot__halo`。
- [ ] 在 UI 测试中断言 trigger 保留至少 88rpx 点击尺寸，同时使用 `border: 0`、`border-radius: 0`、`background: transparent`、`box-shadow: none`。
- [ ] 运行 `node --test miniprogram/tests/ui-ai.test.js`，确认旧圆形入口导致失败。
- [ ] 删除 halo 节点、规则、关键帧及减少动态效果中的 halo 引用，调整 trigger 为透明无圈容器。
- [ ] 重新运行 UI 测试，确认通过。

### Task 3: 建立主要页面视觉分区

**Files:**
- Create: `miniprogram/tests/visual-theme-diversity.test.js`
- Modify: `miniprogram/pages/home/index.wxss`
- Modify: `miniprogram/pages/scale/index.wxss`
- Modify: `miniprogram/pages/tracking/index.wxss`
- Modify: `miniprogram/pages/tracking-trend/index.wxss`
- Modify: `miniprogram/pages/report/index.wxss`
- Modify: `miniprogram/pages/care-pathway/index.wxss`
- Modify: `miniprogram/pages/privacy-settings/index.wxss`
- Modify: `miniprogram/pages/server-settings/index.wxss`
- Modify: `miniprogram/pages/login/index.wxss`
- Modify: `miniprogram/pages/register/index.wxss`
- Modify: `miniprogram/pages/cognitive-center/index.wxss`
- Modify: `miniprogram/pages/ai-chat/index.wxss`

- [ ] 新增测试读取各页面首个 `page` 背景规则，断言各功能域包含设计中指定的主题色，并至少存在八个不同背景签名。
- [ ] 运行 `node --test miniprogram/tests/visual-theme-diversity.test.js`，确认当前大量青灰背景导致失败。
- [ ] 仅修改页面背景渐变和必要的页面容器背景，不更改表单对比度、文字色和计时刺激区。
- [ ] 运行主题测试及现有 UI 测试，修正任何契约冲突。

### Task 4: 完整验证并保留本地

**Files:**
- Verify only: `miniprogram/**/*.js`
- Verify only: Git working tree

- [ ] 运行 `node --test miniprogram/tests/*.test.js`，要求零失败。
- [ ] 对 `miniprogram` 下所有 JavaScript 文件运行 `node --check`，要求零语法错误。
- [ ] 运行 `git diff --check`，要求零差异格式错误。
- [ ] 检查 `git status --short`，确认没有后端、数据库、密钥或上传文件进入本次产品改动。
- [ ] 保持 `feature/a-cognitive-experience` 本地未提交状态，不 commit、不 merge、不 push。
