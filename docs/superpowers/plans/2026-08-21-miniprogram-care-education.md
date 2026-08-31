# 微信小程序临床路径与科普 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用 A 端可验证数据构建五节点辅助筛查路径，并提供离线、权威来源透明的 ADHD 科普阅读体验。

**Architecture:** `care-education.js` 负责路径和内容纯逻辑；路径页复用 `report-data` 的服务端优先/本地降级模型；科普列表和详情只读取内置白名单内容；页面控制器只编排微信 API。

**Tech Stack:** 原生微信小程序、现有 request/report-data、本地纯数据、Node `assert` 测试。

---

### Task 1: 路径与科普纯数据

**Files:** Create `miniprogram/utils/care-education.js`; test `miniprogram/tests/care-education.test.js`。

- [ ] 先写失败测试：五节点规则、局部/完整进度、当前步骤、非法输入、分类、成人/儿童文章、来源和非法 ID。
- [ ] 确认模块缺失红灯。
- [ ] 实现 6 篇离线文章、官方来源和纯逻辑。
- [ ] 运行测试、语法、空白检查。
- [ ] 提交 `feat(miniprogram): model care pathway and education`。

### Task 2: 路由与首页入口

**Files:** Modify `app.json`、`home-dashboard.js`、`home-dashboard.test.js`; create 三个页面 `index.json`。

- [ ] 先写成人/儿童/未知类型和三条路由失败测试。
- [ ] 增加路径、科普快捷入口及路径/列表/详情路由。
- [ ] 验证首页与 JSON。
- [ ] 提交 `feat(miniprogram): enable care and education entries`。

### Task 3: 临床路径页面

**Files:** Create `pages/care-pathway/index.js|wxml|wxss`; tests `care-pathway-page.test.js`、`care-pathway-view.test.js`。

- [ ] 先测试本地模型、服务端合并、离线、防重复、白名单导航、返回和结构。
- [ ] 实现页面控制器，再实现视图与基础样式。
- [ ] 验证路径数据、页面、视图和报告回归。
- [ ] 分两次提交控制器与视图。

### Task 4: 科普列表与详情

**Files:** Create `pages/education/`、`pages/education-detail/`; tests `education-pages.test.js`、`education-views.test.js`。

- [ ] 先测试成人/儿童初始化、分类、非法分类、白名单文章、非法 ID、来源复制、非法来源和返回。
- [ ] 实现两个控制器；不得请求外部内容或写 storage。
- [ ] 先写视图失败测试，再实现列表、详情和基础样式。
- [ ] 验证纯数据、控制、视图和首页。
- [ ] 分两次提交控制器与视图。

### Task 5: D12 全量验证、记录与合并

**Files:** Modify `项目任务与进度.md`。

- [ ] 运行全部测试、全部 JS 语法、JSON 与 `git diff --check`。
- [ ] 检查无 `backend/`、医生端、PPT、远程图片和用户文件差异。
- [ ] D12 更新为 100%，记录五节点规则、权威来源、离线阅读、复制链接、测试数量和外部验收。
- [ ] 提交 `docs: record care and education completion`。
- [ ] 分支干净后安全合并 main，核对用户文件哈希，并在 main 重跑全量验证。
