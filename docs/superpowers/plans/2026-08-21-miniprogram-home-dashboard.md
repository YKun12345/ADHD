# Patient Home Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把患者首页从静态演示页升级为可读取 14 天进度、支持后端离线降级、明确入口状态并能自动回归验证的 D3 页面。

**Architecture:** 新建 `home-dashboard.js` 纯逻辑模块，把接口或缓存数据转换成统一页面状态；首页在 `onShow` 先展示本地状态，再尝试读取现有 `/patient/dashboard_status`。目标页面尚未实现的入口保持明确不可用，不创建虚假页面，也不修改 B 的后端代码。

**Tech Stack:** 微信小程序原生 WXML/WXSS/JavaScript、CommonJS、Node `assert`、现有 `wx.request` 封装。

---

### Task 1: 首页进度纯逻辑

**Files:**
- Create: `miniprogram/tests/home-dashboard.test.js`
- Create: `miniprogram/utils/home-dashboard.js`

- [ ] **Step 1: 写失败测试**

测试必须断言：完成天数去重排序并过滤 1—14；当前天数限制在 1—14；百分比按完成天数计算；非法响应回退为第 1 天；本地来源显示“本地计划”。

```js
const assert = require('node:assert/strict')
const {
  normalizeDashboardStatus,
  createLocalDashboard
} = require('../utils/home-dashboard')

assert.deepEqual(
  normalizeDashboardStatus({
    current_day: 5,
    completed_days: [3, 1, 3, 0, 15],
    total_days: 14
  }),
  {
    currentDay: 5,
    completedDays: [1, 3],
    completedCount: 2,
    totalDays: 14,
    progressPercent: 14,
    dashboardSource: 'server',
    sourceLabel: '已同步'
  }
)

assert.equal(createLocalDashboard({}).currentDay, 1)
assert.equal(createLocalDashboard({}).sourceLabel, '本地计划')
```

- [ ] **Step 2: 运行测试并确认红灯**

Run:

```powershell
node miniprogram/tests/home-dashboard.test.js
```

Expected: `MODULE_NOT_FOUND`，因为 `home-dashboard.js` 尚不存在。

- [ ] **Step 3: 实现最小纯逻辑**

模块导出以下稳定 API：

```js
const TOTAL_DAYS = 14

function normalizeDashboardStatus(payload = {}, source = 'server') {}
function createLocalDashboard(cache = {}) {}

module.exports = {
  TOTAL_DAYS,
  normalizeDashboardStatus,
  createLocalDashboard
}
```

实现要求：只接受整数天数；完成天数使用 `Set` 去重并升序；`progressPercent` 使用 `Math.round(completedCount / 14 * 100)`；接口不能改变固定 14 天计划。

- [ ] **Step 4: 运行测试并确认绿灯**

Run:

```powershell
node miniprogram/tests/home-dashboard.test.js
node --check miniprogram/utils/home-dashboard.js
```

Expected: 首页进度数据测试全部通过，语法检查无输出。

- [ ] **Step 5: 精确提交**

```powershell
git add miniprogram/tests/home-dashboard.test.js miniprogram/utils/home-dashboard.js
git commit -m "feat(miniprogram): normalize patient dashboard progress"
```

### Task 2: 首页任务和入口状态

**Files:**
- Modify: `miniprogram/tests/home-dashboard.test.js`
- Modify: `miniprogram/utils/home-dashboard.js`

- [ ] **Step 1: 先扩展失败测试**

测试 `buildHomeTasks()` 返回行为量表、认知测试、每日追踪三个今日任务，并测试 `buildQuickEntries()` 返回量表、测试、追踪、报告四个入口。当前仅 D3 完成，所以所有目标入口必须带 `available: false` 和可读的 `statusLabel`，不能提供未注册路由。

```js
assert.deepEqual(buildHomeTasks().map((item) => item.id), [
  'scale',
  'cognitive',
  'tracking'
])
assert.equal(buildQuickEntries().every((item) => item.available === false), true)
assert.equal(buildQuickEntries().some((item) => item.url), false)
```

- [ ] **Step 2: 确认测试因导出缺失而失败**

Run: `node miniprogram/tests/home-dashboard.test.js`

Expected: `buildHomeTasks is not a function` 或等价缺失错误。

- [ ] **Step 3: 最小实现任务定义**

任务对象只包含 `id/icon/title/description/available/statusLabel`；快捷入口只包含 `id/icon/title/available/statusLabel`。不添加虚假 URL。

- [ ] **Step 4: 回归并提交**

```powershell
node miniprogram/tests/home-dashboard.test.js
git add miniprogram/tests/home-dashboard.test.js miniprogram/utils/home-dashboard.js
git commit -m "feat(miniprogram): define patient home task states"
```

### Task 3: 首页控制器加载、同步与离线降级

**Files:**
- Create: `miniprogram/tests/home-page.test.js`
- Modify: `miniprogram/pages/home/index.js`

- [ ] **Step 1: 写页面失败测试**

测试通过 mock `Page`、`wx` 和 `request` 验证：

1. `onLoad` 读取 `current_user.full_name`；
2. `onShow` 先读取 `patient_dashboard_cache`；
3. 接口成功时请求 `GET /patient/dashboard_status`、更新进度并写缓存；
4. 接口失败时保留本地状态，显示“暂时无法同步，当前展示本地计划”，不跳转、不清空姓名；
5. 点击不可用入口只显示“该功能正在按计划开发”，不调用 `wx.navigateTo`。

核心断言：

```js
assert.deepEqual(calls.request[0], {
  url: '/patient/dashboard_status',
  method: 'GET'
})
assert.equal(page.data.progressPercent, 14)
assert.equal(calls.navigateTo.length, 0)
```

- [ ] **Step 2: 运行并确认旧控制器不满足测试**

Run: `node miniprogram/tests/home-page.test.js`

Expected: 因缺少 `refreshDashboard`、缓存或标准状态而失败。

- [ ] **Step 3: 最小修改首页控制器**

首页导入 `request`、`createLocalDashboard`、`normalizeDashboardStatus`、`buildHomeTasks` 和 `buildQuickEntries`。`onShow()` 调用异步 `refreshDashboard()`；同步成功写入 `patient_dashboard_cache`，失败只更新 `statusMessage` 和来源标签。

入口处理统一为：

```js
handleEntryTap(event) {
  const item = this.data.quickEntries.find(
    (entry) => entry.id === event.currentTarget.dataset.id
  )

  if (!item || !item.available || !item.url) {
    wx.showToast({
      title: '该功能正在按计划开发',
      icon: 'none'
    })
    return
  }

  wx.navigateTo({ url: item.url })
}
```

- [ ] **Step 4: 运行页面测试、纯逻辑测试和语法检查**

```powershell
node miniprogram/tests/home-page.test.js
node miniprogram/tests/home-dashboard.test.js
node --check miniprogram/pages/home/index.js
```

Expected: 全部通过。

- [ ] **Step 5: 精确提交**

```powershell
git add miniprogram/tests/home-page.test.js miniprogram/pages/home/index.js
git commit -m "feat(miniprogram): load patient dashboard status"
```

### Task 4: 首页视图契约和可访问状态

**Files:**
- Create: `miniprogram/tests/home-view.test.js`
- Modify: `miniprogram/pages/home/index.wxml`
- Modify: `miniprogram/pages/home/index.wxss`

- [ ] **Step 1: 先写视图失败测试**

静态测试读取 WXML/WXSS，并断言包含：动态进度宽度、来源标签、同步状态、`data-id`、禁用状态类、任务状态文字、医疗免责声明。

```js
assert.match(wxml, /style="width: \{\{progressPercent\}\}%;"/)
assert.match(wxml, /\{\{sourceLabel\}\}/)
assert.match(wxml, /data-id="\{\{item\.id\}\}"/)
assert.match(wxml, /quick-item--disabled/)
assert.match(wxss, /\.dashboard-source/)
assert.match(wxss, /\.entry-status/)
```

- [ ] **Step 2: 运行并确认旧视图失败**

Run: `node miniprogram/tests/home-view.test.js`

Expected: 首个缺少的动态进度或来源标签断言失败。

- [ ] **Step 3: 最小实现视图**

进度条使用 `progressPercent`；来源标签展示 `sourceLabel`；`statusMessage` 仅在非空时显示；任务和快捷入口使用 `data-id`；不可用入口增加禁用样式与“按计划开发”标签，但保留点击后的明确说明。

- [ ] **Step 4: 验证并提交**

```powershell
node miniprogram/tests/home-view.test.js
node miniprogram/tests/home-page.test.js
node miniprogram/tests/home-dashboard.test.js
git diff --check
git add miniprogram/pages/home/index.wxml miniprogram/pages/home/index.wxss miniprogram/tests/home-view.test.js
git commit -m "style(miniprogram): present dashboard progress states"
```

### Task 5: D3 全量回归、记录和交接

**Files:**
- Modify: `项目任务与进度.md`
- Modify: `docs/superpowers/plans/2026-08-21-miniprogram-home-dashboard.md`

- [ ] **Step 1: 运行全部小程序 Node 测试**

```powershell
Get-ChildItem -LiteralPath 'miniprogram\tests' -Filter '*.test.js' | Sort-Object Name | ForEach-Object {
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: 注册与首页测试全部通过。

- [ ] **Step 2: 运行全部相关语法与 Git 检查**

```powershell
Get-ChildItem -LiteralPath 'miniprogram' -Recurse -Filter '*.js' | ForEach-Object {
  node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
git diff --check
git status --short
```

Expected: 语法检查和空白检查通过；状态中只有计划和进度记录。

- [ ] **Step 3: 更新进度记录**

将 D3 更新为 100%，写入实际测试数量、提交号、离线降级结果和 D4 下一步；重新计算 A 端与总目标的保守进度。不得把未进行的微信开发者工具人工检查写为通过。

- [ ] **Step 4: 提交记录**

```powershell
git add docs/superpowers/plans/2026-08-21-miniprogram-home-dashboard.md 项目任务与进度.md
git commit -m "docs: record patient dashboard completion"
```

Expected: D3 代码和记录都有独立、可追溯提交，工作区干净。

## 计划自审

- 覆盖 D3 的姓名、14 天进度、任务、快捷入口、真实接口、离线降级和数据来源标识；
- 未修改或要求修改任何 B 文件；
- 未创建尚未实现的虚假目标页面或路由；
- 控制器、纯逻辑和视图分别测试；
- 每个生产行为之前都有失败测试；
- 最终步骤包含进度、证据和工作日志更新。

## 执行记录（2026-08-21）

- **Task 1—2：已完成。** 先运行 `home-dashboard.test.js`，观察到 `MODULE_NOT_FOUND` 红灯；随后实现进度清洗、固定 14 天、百分比、来源标签、今日任务和快捷入口状态。提交：`3daec6a`。
- **Task 3：已完成。** 先运行 `home-page.test.js`，观察到 `onShow is not a function` 红灯；随后实现本地缓存优先、真实接口同步、离线保留页面和安全入口处理。提交：`a006a8b`。
- **Task 4：已完成。** 先运行 `home-view.test.js`，观察到动态进度样式缺失红灯；随后实现动态进度条、数据来源、离线消息和禁用入口样式。提交：`bd2224d`。
- **Task 5：已完成。** 8 个小程序测试文件全部通过，20 个 JavaScript 文件语法检查通过，`git diff --check` 通过。D3 微信开发者工具视觉复核没有伪报为已执行，统一保留到 D14 UI/真机验收阶段。
- **范围确认：** 本阶段只修改 `miniprogram/`、本计划和进度记录，没有修改 `backend/` 或医生 Web。
