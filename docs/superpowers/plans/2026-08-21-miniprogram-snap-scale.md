# Miniprogram SNAP-IV Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 D5 SNAP-IV 26 题，并让成人与儿童共用稳定、可测试的量表页面。

**Architecture:** 抽取不访问微信 API 的通用量表会话工具，ASRS 与 SNAP-IV 各自保留配置和绑定 API。页面按患者类型选择模型，后端仍是唯一医学算分来源。

**Tech Stack:** 原生微信小程序、CommonJS、Node `assert`、现有请求封装。

---

### Task 1: 通用量表会话与 ASRS 无行为变化重构

**Files:**
- Create: `miniprogram/tests/scale-session.test.js`
- Create: `miniprogram/utils/scale-session.js`
- Modify: `miniprogram/utils/asrs-scale.js`

- [ ] 先测试通用配置的答案范围、草稿截断、不可变更新、进度和 payload，并观察模块不存在红灯。
- [ ] 实现 `createScaleSession(config)`，返回 `normalizeDraftAnswers/setAnswer/getQuestionState/buildScalePayload`。
- [ ] 把 ASRS 的通用函数改为会话绑定导出，保持现有 ASRS 测试原样通过。
- [ ] 运行 `scale-session.test.js` 与 `asrs-scale.test.js`，语法检查后提交 `refactor(miniprogram): share scale session logic`。

### Task 2: SNAP-IV 26 题配置

**Files:**
- Create: `miniprogram/tests/snap-scale.test.js`
- Create: `miniprogram/utils/snap-scale.js`

- [ ] 先测试 26 题、0—3、家长代填、独立草稿键、非法草稿和完整 payload，观察模块不存在红灯。
- [ ] 逐题迁移 `js/scale.js` 儿童题库，使用通用会话绑定。
- [ ] 运行 SNAP、ASRS 和通用会话测试，语法检查后提交 `feat(miniprogram): add SNAP-IV scale model`。

### Task 3: 通用成人/儿童量表页面

**Files:**
- Modify: `miniprogram/tests/scale-page.test.js`
- Modify: `miniprogram/tests/scale-view.test.js`
- Modify: `miniprogram/pages/scale/index.js`
- Modify: `miniprogram/pages/scale/index.wxml`

- [ ] 先把儿童测试从“不支持”改为 26 题、四选项、SNAP 草稿和 `SNAP_IV/parent` payload，观察失败。
- [ ] 页面按患者类型选择模型并更新标题、说明、选项和草稿键；未知类型保留不支持提示。
- [ ] 映射 `low/medium/high` 为低/中等/高风险显示标签，但保留原始结果对象。
- [ ] 运行页面、视图、ASRS 和 SNAP 测试后提交 `feat(miniprogram): support child SNAP-IV flow`。

### Task 4: 启用儿童首页量表入口

**Files:**
- Modify: `miniprogram/tests/home-dashboard.test.js`
- Modify: `miniprogram/tests/home-page.test.js`
- Modify: `miniprogram/utils/home-dashboard.js`

- [ ] 先要求儿童量表入口 `available: true` 且路由为 `/pages/scale/index`，观察旧的 D5 开放断言失败。
- [ ] 成人和儿童都启用量表，未知类型仍锁定。
- [ ] 运行全部首页和量表测试后提交 `feat(miniprogram): enable child scale entry`。

### Task 5: 全量验证与记录

**Files:**
- Modify: `项目任务与进度.md`
- Modify: `docs/superpowers/plans/2026-08-21-miniprogram-snap-scale.md`

- [ ] 运行全部小程序测试、全部 JavaScript `node --check` 和 `git diff --check`。
- [ ] 把 D5 更新为 100%，记录测试数量、提交号、成人/儿童边界和真实算分待 B 联调。
- [ ] 独立提交记录，确认 `git status --short` 干净。

## 计划自审

- 任务顺序为通用逻辑、儿童配置、页面、入口、记录；
- 所有新增行为先有失败测试；
- ASRS 公共 API 保持兼容；
- 不修改 B 文件、不实现本地医学算分；
- 完成证据与联调边界分别记录。

## 执行记录（2026-08-21）

- **Task 1：已完成。** `scale-session.test.js` 首次因模块不存在出现 `MODULE_NOT_FOUND`，随后实现通用量表会话并在 ASRS 原有测试全部通过的前提下完成重构。提交：`3bd45cb`。
- **Task 2：已完成。** `snap-scale.test.js` 首次因模块不存在出现 `MODULE_NOT_FOUND`，随后逐题迁移 26 题、四级选项、家长代填和独立草稿。提交：`8c3f769`。
- **Task 3：已完成。** 页面测试先观察到儿童 `false !== true` 红灯，随后实现成人/儿童模型选择、两个草稿键、两个 payload 和风险中文展示。提交：`b9dd658`。
- **Task 4：已完成。** 首页测试先观察到儿童入口 `false !== true` 红灯，随后启用儿童 `/pages/scale/index`，未知类型继续锁定。提交：`02f65f0`。
- **Task 5：已完成。** 13 个小程序测试文件和 29 个 JavaScript 文件语法检查全部通过，`git diff --check` 通过。没有修改 B 文件或实现本地医学算分。
- **人工验收边界：** 新量表页面尚未在微信开发者工具中由用户目视复核，该项统一保留到 D14 UI/真机验收，不影响有自动证据的 D5 A 端代码完成状态。
