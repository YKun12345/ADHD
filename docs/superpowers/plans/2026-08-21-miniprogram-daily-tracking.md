# Miniprogram Daily Tracking Implementation Plan

**Goal:** 完成 D8 14 天每日追踪、本地演示数据、离线待同步和首页入口。

**Architecture:** `tracking-data.js` 负责纯数据；tracking 页面编排微信存储和请求；首页只消费可用路由。

### Task 1: 纯数据（先测试）

- [x] 新增失败测试覆盖表单校验、payload、本地覆盖、汇总和 14 条演示数据。
- [x] 实现 `miniprogram/utils/tracking-data.js` 并使测试转绿。
- [x] 相关语法与空白检查通过并提交。

### Task 2: 页面控制（先测试）

- [x] 新增失败测试覆盖加载、字段选择、提交、本地缓存、后端成功/失败、防重复和演示数据。
- [x] 实现 `pages/tracking/index.js/json`。
- [x] 相关回归通过并提交。

### Task 3: 视图（先测试）

- [x] 新增失败结构测试覆盖进度、字段、状态、演示标签和免责声明。
- [x] 实现 `pages/tracking/index.wxml/wxss`。
- [x] 相关回归通过并提交。

### Task 4: 路由、首页和记录（先测试）

- [x] 测试成人/儿童 tracking 入口与 app 路由，观察红灯。
- [x] 更新 app、首页数据、全量验证和项目进度。
- [x] 提交并确认工作区干净。

## 自审

- 只改 A 文件；不伪造 B 成功；演示数据明确标记；先测试后实现；不输出诊断或用药建议。
