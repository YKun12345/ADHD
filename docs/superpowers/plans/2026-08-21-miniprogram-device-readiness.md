# 微信小程序真机预览准备 Implementation Plan

**Goal:** 让小程序可配置真机后端地址，降低旧 Android 内核风险，并交付可执行的双端验收清单。

### Task 1: API 地址纯逻辑与请求层

- [ ] 创建 `api-config.js` 与失败测试，覆盖安全 URL 规则。
- [ ] 扩展 `request.js` 测试，先确认固定 127.0.0.1 行为失败。
- [ ] 实现运行时地址、候选地址和 `skipAuth`，保持 401 行为。
- [ ] 验证并提交 `feat(miniprogram): support configurable api base url`。

### Task 2: 服务器设置页面与入口

- [ ] 先测试页面成功/失败/防重复/默认恢复和登录、首页入口。
- [ ] 创建 `pages/server-settings/` 并登记路由。
- [ ] 实现 WXML/WXSS，明确局域网 HTTP 仅用于开发。
- [ ] 验证并分逻辑/视图提交。

### Task 3: 旧内核兼容修复

- [ ] 写静态失败测试，定位生产 `.at(` 与 `Object.hasOwn(`。
- [ ] 做等价替换，运行相关报告、追踪测试和全量回归。
- [ ] 提交 `fix(miniprogram): avoid newer runtime helpers`。

### Task 4: 验收清单、全量验证与记录

- [ ] 创建双端逐步清单，实体操作保持未勾选。
- [ ] 运行全部测试、JS、JSON、配置边界与 Git 检查。
- [ ] D13 记录为 75%“代码准备完成、双端待验收”，不得虚报 100%。
- [ ] 提交记录并安全合并 main，复核用户文件哈希。
