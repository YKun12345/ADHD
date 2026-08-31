# 微信小程序 AI 助手聊天 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在患者端小程序增加安全、可重试、只使用真实接口回复的 AI 助手聊天 UI。

**Architecture:** 以纯逻辑 `ai-chat` 模块负责输入、上下文、历史裁剪和响应标准化；页面控制器只编排微信 API 与请求状态；首页只启用患者类型明确的 AI 快捷入口。接口失败不生成本地回答，聊天正文不写 storage。

**Tech Stack:** 原生微信小程序 WXML/WXSS/JavaScript、现有 `request.js`、Node.js `node:assert/strict` 测试。

---

### Task 1: AI 聊天纯逻辑

**Files:**
- Create: `miniprogram/utils/ai-chat.js`
- Test: `miniprogram/tests/ai-chat.test.js`

- [ ] 写失败测试：模块导出、1—4000 字校验、上下文白名单、最近 6 条有效历史、请求 snake_case、非法响应、降级响应、成人/儿童引导和建议。
- [ ] 运行 `node miniprogram/tests/ai-chat.test.js`，确认因模块缺失失败。
- [ ] 实现最小纯逻辑，不访问 `wx`，不保存聊天正文，不生成接口失败回答。
- [ ] 运行测试及两个文件的 `node --check`。
- [ ] 精确提交：`feat(miniprogram): model safe ai chat`。

### Task 2: 登记路由并启用首页入口

**Files:**
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/utils/home-dashboard.js`
- Modify: `miniprogram/tests/home-dashboard.test.js`
- Create: `miniprogram/pages/ai-chat/index.json`

- [ ] 先扩展失败测试：成人/儿童 AI 入口可用、未知类型不可用、路由存在。
- [ ] 运行首页测试，确认 AI 入口缺失。
- [ ] 增加白名单入口 `/pages/ai-chat/index`，只放快捷入口，不加入每日任务。
- [ ] 验证首页测试和两个 JSON。
- [ ] 精确提交：`feat(miniprogram): enable ai assistant entry`。

### Task 3: AI 聊天页面控制器

**Files:**
- Create: `miniprogram/pages/ai-chat/index.js`
- Test: `miniprogram/tests/ai-chat-page.test.js`

- [ ] 写页面失败测试：成人/儿童初始化、scope 参数、输入、建议、合法请求、最近历史、成功/降级、非法响应、失败、原消息重试、防重复、清空、返回和卸载保护。
- [ ] 运行测试，确认页面模块缺失。
- [ ] 实现页面内存状态机和 `POST /ai/chat`；不读取或写入聊天 storage，不输出正文到 Console。
- [ ] 验证页面、纯逻辑和语法。
- [ ] 精确提交：`feat(miniprogram): implement ai chat controller`。

### Task 4: 聊天视图与基础样式

**Files:**
- Create: `miniprogram/pages/ai-chat/index.wxml`
- Create: `miniprogram/pages/ai-chat/index.wxss`
- Test: `miniprogram/tests/ai-chat-view.test.js`

- [ ] 写结构失败测试：安全提示、儿童提示、上下文、scroll-view、guide/user/assistant、降级、引用范围、失败重试、建议、textarea、计数、发送、底部锚点和按钮 flex 居中。
- [ ] 运行测试，确认视图缺失。
- [ ] 实现纯文本聊天结构和基础响应式样式，不做 D14 精细美化。
- [ ] 验证视图、页面控制和首页入口。
- [ ] 精确提交：`feat(miniprogram): build ai assistant view`。

### Task 5: D11 全量验证、记录与合并

**Files:**
- Modify: `项目任务与进度.md`

- [ ] 运行全部小程序测试；预期原有 31 个加 3 个 AI 测试，共 34 个。
- [ ] 运行全部 JavaScript `node --check`、JSON 解析和 `git diff --check`。
- [ ] 检查修改边界，不得出现 `backend/`、医生端、PPT 或用户未提交文件。
- [ ] 更新 D11 为 100%，记录真实接口契约、会话内存、降级/失败重试、安全边界、测试数量和提交证据；D12 保持未开始。
- [ ] 精确提交：`docs: record ai assistant completion`。
- [ ] 确认功能分支干净，安全合并到 `main`，核对主工作区用户改动哈希不变，并在主分支再次运行全量验证。
