# 微信小程序综合报告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为患者端小程序增加可离线降级的综合报告，汇总量表、认知测试和 14 天追踪，并展示原始五维量表雷达图与注意力趋势图。

**Architecture:** 新建纯逻辑 `report-data` 模块，将服务端响应与本地 storage 转换为稳定页面模型；报告页面先显示本地模型，再按分区规则合并 `/patient/comprehensive_report`。量表雷达分值直接使用后端既有 `0—20` 数据，Canvas 只绘图，不承担医学计算。

**Tech Stack:** 原生微信小程序 WXML/WXSS/JavaScript、Canvas 2D 兼容接口、Node.js `node:assert/strict` 测试、现有 `request.js` 与本地 storage。

---

## 文件结构

- 创建 `miniprogram/utils/report-data.js`：标准化、合并、完成度、雷达几何。
- 创建 `miniprogram/tests/report-data.test.js`：纯逻辑边界测试。
- 修改 `miniprogram/pages/scale/index.js`：缓存合法量表结果。
- 修改 `miniprogram/tests/scale-page.test.js`：缓存行为回归测试。
- 修改 `miniprogram/app.json`：登记报告路由。
- 修改 `miniprogram/utils/home-dashboard.js`：启用报告入口。
- 修改 `miniprogram/tests/home-dashboard.test.js`：入口测试。
- 创建 `miniprogram/pages/report/index.js`：页面控制和 Canvas 绘制。
- 创建 `miniprogram/pages/report/index.json`：页面标题。
- 创建 `miniprogram/tests/report-page.test.js`：页面控制测试。
- 创建 `miniprogram/pages/report/index.wxml`：报告结构。
- 创建 `miniprogram/pages/report/index.wxss`：基础布局。
- 创建 `miniprogram/tests/report-view.test.js`：结构、样式和路由测试。
- 修改 `项目任务与进度.md`：D10 证据和工作日志。

### Task 1: 报告纯数据模型

**Files:**
- Create: `miniprogram/utils/report-data.js`
- Test: `miniprogram/tests/report-data.test.js`

- [ ] **Step 1: 写失败测试，固定导出接口和本地存储键**

测试导入：

```js
const {
  SCALE_LATEST_RESULT_KEY,
  isReportableScaleResult,
  buildLocalReport,
  mergeReport,
  createRadarGeometry
} = require('../utils/report-data')

assert.equal(SCALE_LATEST_RESULT_KEY, 'scale_latest_result')
assert.equal(isReportableScaleResult({}), false)
```

构造成人量表、两项认知结果和两个追踪日，断言：

```js
const localReport = buildLocalReport({
  user: {
    full_name: '综合报告患者',
    patient_profile: { patient_type: 'adult' }
  },
  scaleResult: {
    scale_type: 'ASRS',
    respondent_type: 'self',
    total_score: 28,
    risk_level: 'medium',
    radar_scores: {
      attention_control: 12,
      organization: 10,
      task_activation: 11,
      hyperactivity: 8,
      impulsivity: 9
    },
    summary: '量表摘要',
    recommendations: ['继续完成追踪'],
    created_at: '2026-08-21T08:00:00.000Z'
  },
  cognitiveResults: {
    reaction: {
      test_type: 'reaction',
      result_json: {
        raw_result: { accuracy: 80, average_reaction_time_ms: 420 },
        finished_at: '2026-08-21T08:10:00.000Z'
      }
    },
    stroop: {
      test_type: 'stroop',
      result_json: {
        raw_result: { accuracy: 75, average_reaction_time_ms: 690 },
        finished_at: '2026-08-21T08:20:00.000Z'
      }
    }
  },
  trackingLogs: [
    { day_index: 1, mood_tag: '4', attention_rating: 3, focus_minutes: 60 },
    { day_index: 3, mood_tag: '2', attention_rating: 5, focus_minutes: 90 }
  ]
})

assert.equal(localReport.patientName, '综合报告患者')
assert.equal(localReport.patientTypeLabel, '成人患者')
assert.equal(localReport.sourceLabel, '本地结果')
assert.equal(localReport.scale.hasData, true)
assert.equal(localReport.scale.radarAxes.length, 5)
assert.equal(localReport.cognitive.completedCount, 2)
assert.equal(localReport.tracking.completedCount, 2)
assert.equal(localReport.tracking.averageAttention, 4)
assert.equal(localReport.coverage.completedCount, 3)
assert.equal(localReport.coverage.percent, 100)
```

再覆盖：儿童五维键名、雷达缺轴、负数/大于20/NaN/Infinity、非法量表、空认知、非法日期、演示追踪、全空报告、服务端量表覆盖本地量表、本地认知和追踪覆盖服务端摘要、服务端部分响应不清空本地合法分区。

- [ ] **Step 2: 运行测试，确认因模块缺失而失败**

Run: `node miniprogram/tests/report-data.test.js`

Expected: FAIL，错误包含 `Cannot find module '../utils/report-data'`。

- [ ] **Step 3: 实现最小纯逻辑接口**

`report-data.js` 必须导出：

```js
module.exports = {
  SCALE_LATEST_RESULT_KEY,
  isReportableScaleResult,
  buildLocalReport,
  mergeReport,
  createRadarGeometry
}
```

内部规则：

```js
const SCALE_LATEST_RESULT_KEY = 'scale_latest_result'
const RADAR_MAX = 20
const RADAR_SCHEMAS = Object.freeze({
  ASRS: [
    ['attention_control', '注意控制'],
    ['organization', '组织管理'],
    ['task_activation', '任务启动'],
    ['hyperactivity', '多动表现'],
    ['impulsivity', '冲动控制']
  ],
  SNAP_IV: [
    ['attention_control', '注意控制'],
    ['organization', '组织管理'],
    ['hyperactivity', '多动表现'],
    ['impulsivity', '冲动控制'],
    ['emotional_regulation', '情绪调节']
  ]
})
```

实现要求：

- 只有有限数字才进入报告；雷达值裁剪到 `0—20`。
- `isReportableScaleResult()` 必须确认量表类型、填写方式、有限总分、合法风险、摘要、建议数组和完整五维雷达均存在。
- 雷达五个键必须全部存在才设置 `hasRadar: true`，缺轴时 `radarAxes: []`。
- 风险仅接受 `low`、`medium`、`high`，分别显示“低风险”“中等风险”“高风险”。
- 本地认知仅接受 `reaction` 和 `stroop` 的合法 `result_json.raw_result`。
- 本地追踪通过现有 `buildTrackingTrendModel()` 计算均值和断点序列。
- `mergeReport(local, server)` 只让合法服务端量表覆盖本地量表；本地已有认知或追踪时保持本地，否则采用合法服务端摘要。
- `coverage` 按量表、至少一项认知、至少一天追踪三个模块计算。
- `createRadarGeometry(axes, 300, 260, 92)` 返回五层网格顶点、数据顶点与五个标签坐标；无五轴时返回 `null`。

- [ ] **Step 4: 运行测试并检查语法**

Run:

```powershell
node miniprogram/tests/report-data.test.js
node --check miniprogram/utils/report-data.js
node --check miniprogram/tests/report-data.test.js
```

Expected: 输出“综合报告数据测试全部通过”，三个命令退出码均为 0。

- [ ] **Step 5: 精确提交**

```powershell
git add miniprogram/utils/report-data.js miniprogram/tests/report-data.test.js
git diff --cached --check
git commit -m "feat(miniprogram): model comprehensive report data"
```

### Task 2: 缓存最近一次合法量表结果

**Files:**
- Modify: `miniprogram/pages/scale/index.js`
- Modify: `miniprogram/tests/scale-page.test.js`

- [ ] **Step 1: 写缓存失败测试**

把 `completeResult` 扩充为包含 `scale_type`、`respondent_type`、五维 `radar_scores` 和 `created_at` 的完整响应。成功提交后断言：

```js
assert.deepEqual(storage.scale_latest_result, completeResult)
assert.deepEqual(calls.storageWrites.at(-1), [
  'scale_latest_result',
  completeResult
])
```

失败请求前放入旧缓存，失败后断言旧缓存未被覆盖；不完整响应同样不能覆盖。

- [ ] **Step 2: 运行测试，确认缓存断言失败**

Run: `node miniprogram/tests/scale-page.test.js`

Expected: FAIL，`actual` 为 `undefined`，`expected` 为完整量表响应。

- [ ] **Step 3: 最小实现成功缓存**

在量表页面导入：

```js
const {
  SCALE_LATEST_RESULT_KEY,
  isReportableScaleResult
} = require('../../utils/report-data')
```

仅在页面现有 `isCompleteResult(result)` 通过后，再用报告完整性检查决定是否缓存：

```js
if (isReportableScaleResult(result)) {
  wx.setStorageSync(SCALE_LATEST_RESULT_KEY, result)
}
```

不在请求失败、响应不完整或提交开始时写入该键。

- [ ] **Step 4: 验证量表与报告数据测试**

Run:

```powershell
node miniprogram/tests/scale-page.test.js
node miniprogram/tests/report-data.test.js
node --check miniprogram/pages/scale/index.js
```

Expected: 两个测试文件通过，语法检查退出码为 0。

- [ ] **Step 5: 精确提交**

```powershell
git add miniprogram/pages/scale/index.js miniprogram/tests/scale-page.test.js
git diff --cached --check
git commit -m "feat(miniprogram): cache latest scale result"
```

### Task 3: 登记报告路由并启用首页入口

**Files:**
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/utils/home-dashboard.js`
- Modify: `miniprogram/tests/home-dashboard.test.js`
- Create: `miniprogram/pages/report/index.json`

- [ ] **Step 1: 写失败入口测试**

在 `home-dashboard.test.js` 对成人和儿童分别断言：

```js
const adultReport = buildQuickEntries('adult').find((item) => item.id === 'report')
assert.equal(adultReport.available, true)
assert.equal(adultReport.statusLabel, '查看报告')
assert.equal(adultReport.url, '/pages/report/index')

const childReport = buildQuickEntries('child').find((item) => item.id === 'report')
assert.equal(childReport.available, true)
assert.equal(childReport.url, '/pages/report/index')
```

同时读取 `app.json` 并断言包含 `pages/report/index`。

- [ ] **Step 2: 运行测试，确认入口仍不可用**

Run: `node miniprogram/tests/home-dashboard.test.js`

Expected: FAIL，报告入口 `available` 实际为 `false`。

- [ ] **Step 3: 实现报告可用性**

新增：

```js
function getReportAvailability(patientType) {
  if (patientType === 'adult' || patientType === 'child') {
    return {
      available: true,
      statusLabel: '查看报告',
      url: '/pages/report/index'
    }
  }
  return { available: false, statusLabel: '按计划开发' }
}
```

`buildQuickEntries()` 的报告项展开该结果；未知患者类型仍不可用。把 `pages/report/index` 添加到 `app.json` 的 `pages` 数组，并创建：

```json
{
  "navigationBarTitleText": "综合报告"
}
```

- [ ] **Step 4: 验证入口与 JSON**

Run:

```powershell
node miniprogram/tests/home-dashboard.test.js
Get-Content miniprogram/app.json -Raw | ConvertFrom-Json | Out-Null
Get-Content miniprogram/pages/report/index.json -Raw | ConvertFrom-Json | Out-Null
```

Expected: 测试通过，两个 JSON 均可解析。

- [ ] **Step 5: 精确提交**

```powershell
git add miniprogram/app.json miniprogram/utils/home-dashboard.js miniprogram/tests/home-dashboard.test.js miniprogram/pages/report/index.json
git diff --cached --check
git commit -m "feat(miniprogram): enable comprehensive report entry"
```

### Task 4: 报告页面控制器

**Files:**
- Create: `miniprogram/pages/report/index.js`
- Test: `miniprogram/tests/report-page.test.js`

- [ ] **Step 1: 写页面控制失败测试**

测试桩必须记录 `request`、`navigateTo`、`navigateBack`、Canvas 和 storage 读取。创建页面后验证：

```js
page.onLoad()
assert.equal(page.data.patientName, '报告测试患者')

await page.onShow()
assert.deepEqual(calls.requests[0], {
  url: '/patient/comprehensive_report',
  method: 'GET'
})
assert.equal(page.data.loading, false)
assert.equal(page.data.sourceLabel, '已同步')
```

离线时断言本地数据仍存在且 `statusMessage` 为“暂时无法同步，当前展示本地结果”；快速连续刷新只发送一个请求；空报告不调用 Canvas；导航分别进入：

```text
/pages/scale/index
/pages/cognitive-center/index
/pages/tracking/index
/pages/tracking-trend/index
```

- [ ] **Step 2: 运行测试，确认页面模块缺失**

Run: `node miniprogram/tests/report-page.test.js`

Expected: FAIL，错误包含 `Cannot find module '../pages/report/index'`。

- [ ] **Step 3: 实现页面生命周期与请求合并**

页面初始状态至少包含：

```js
data: {
  patientName: '患者',
  patientTypeLabel: '患者',
  sourceLabel: '本地结果',
  statusMessage: '',
  loading: false,
  hasAnyData: false,
  scale: { hasData: false, hasRadar: false, radarAxes: [] },
  cognitive: { hasData: false, completedCount: 0, cards: [] },
  tracking: { hasData: false, completedCount: 0, totalDays: 14 },
  coverage: { completedCount: 0, totalCount: 3, percent: 0 },
  professionalData: '影像与模型结果尚未接入患者端'
}
```

生命周期与方法：

- `onLoad()` 读取 `current_user` 并建立本地模型。
- `onShow()` 调用 `refreshReport()`。
- `refreshReport()` 有 `loading` 防重入；先刷新本地，再 GET 服务端并 `mergeReport()`；失败只更新轻量说明。
- `drawCharts()` 仅在 `scale.hasRadar` 或 `tracking.hasData` 时调用对应 Canvas。
- `openTask(event)` 使用固定白名单路由，不接受任意 URL。
- `openTrend()` 进入完整趋势页。
- `goBack()` 优先 `navigateBack({delta:1})`。

Canvas 绘制必须使用 `createRadarGeometry()` 和 `createChartPoints()` 的结果；不在绘制函数内计算医学分数。

- [ ] **Step 4: 验证页面控制、数据和语法**

Run:

```powershell
node miniprogram/tests/report-page.test.js
node miniprogram/tests/report-data.test.js
node --check miniprogram/pages/report/index.js
node --check miniprogram/tests/report-page.test.js
```

Expected: 两个测试通过，两个语法检查退出码为 0。

- [ ] **Step 5: 精确提交**

```powershell
git add miniprogram/pages/report/index.js miniprogram/tests/report-page.test.js
git diff --cached --check
git commit -m "feat(miniprogram): implement report page controller"
```

### Task 5: 报告视图、基础样式与 Canvas

**Files:**
- Create: `miniprogram/pages/report/index.wxml`
- Create: `miniprogram/pages/report/index.wxss`
- Create: `miniprogram/tests/report-view.test.js`

- [ ] **Step 1: 写结构失败测试**

测试必须读取 WXML/WXSS 并检查：

```js
const requiredWxml = [
  '综合辅助筛查报告',
  '{{patientName}}',
  '{{patientTypeLabel}}',
  '{{sourceLabel}}',
  '{{coverage.percent}}%',
  'canvas-id="reportRadarCanvas"',
  'wx:if="{{scale.hasRadar}}"',
  'wx:for="{{cognitive.cards}}"',
  'canvas-id="reportTrendCanvas"',
  'bindtap="openTask"',
  'bindtap="openTrend"',
  '影像与模型结果尚未接入患者端',
  '仅用于辅助筛查，不替代专业医生诊断'
]
```

样式至少检查 `.report-page`、`.summary-card`、`.coverage-bar`、`.report-card`、`.radar-canvas`、`.metric-grid`、`.trend-canvas`、`.empty-panel`、`.medical-tip`。任何按钮样式必须使用 flex 水平、垂直居中。

- [ ] **Step 2: 运行测试，确认视图文件缺失**

Run: `node miniprogram/tests/report-view.test.js`

Expected: FAIL，错误包含 `ENOENT` 或缺少指定 WXML 片段。

- [ ] **Step 3: 实现 WXML 页面结构**

按照固定顺序实现：顶部返回与标题、综合完成度、量表卡、认知卡、追踪卡、专业数据说明和医疗提示。每个缺失模块都有任务按钮，按钮只携带 `data-task="scale|cognitive|tracking"`。

雷达无完整五维数据时显示“暂无完整雷达数据”；追踪无数据时不创建伪造折线。演示追踪显示“本地演示”。

- [ ] **Step 4: 实现基础 WXSS**

沿用现有深蓝 `#17324d`、青绿 `#3f7c78`、背景 `#f4f7fa`，只建立可读层级，不进行 D14 精细美化。所有容器使用 `box-sizing: border-box`，Canvas 设定稳定 rpx 尺寸，长摘要允许换行，小屏按钮不得溢出。

- [ ] **Step 5: 验证视图与页面控制**

Run:

```powershell
node miniprogram/tests/report-view.test.js
node miniprogram/tests/report-page.test.js
node miniprogram/tests/home-dashboard.test.js
```

Expected: 三个测试文件全部通过。

- [ ] **Step 6: 精确提交**

```powershell
git add miniprogram/pages/report/index.wxml miniprogram/pages/report/index.wxss miniprogram/tests/report-view.test.js
git diff --cached --check
git commit -m "feat(miniprogram): build comprehensive report view"
```

### Task 6: D10 全量验证、进度记录与完成提交

**Files:**
- Modify: `项目任务与进度.md`

- [ ] **Step 1: 运行全部自动测试**

Run:

```powershell
$tests = Get-ChildItem miniprogram/tests -Filter '*.test.js' -File | Sort-Object Name
foreach ($test in $tests) {
  node $test.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Output "全部自动测试通过，共 $($tests.Count) 个测试文件"
```

Expected: 原有 28 个加 3 个报告测试，共 31 个测试文件全部通过。

- [ ] **Step 2: 运行全部语法与配置检查**

Run:

```powershell
$jsFiles = Get-ChildItem miniprogram -Filter '*.js' -File -Recurse
foreach ($file in $jsFiles) {
  node --check $file.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$jsonFiles = Get-ChildItem miniprogram -Filter '*.json' -File -Recurse
foreach ($file in $jsonFiles) {
  Get-Content $file.FullName -Raw | ConvertFrom-Json | Out-Null
}
git diff --check
```

Expected: JavaScript、JSON 和空白检查均为 0 错误；LF/CRLF 提示不算代码错误。

- [ ] **Step 3: 检查 A/B 修改边界**

Run:

```powershell
git status --short
git diff --name-only HEAD
```

Expected: 只出现本计划列出的 `miniprogram/` 文件和 `项目任务与进度.md`，不得出现 `backend/`、`doctor_*.html`、`HGST-main/` 或 `findviz/`。

- [ ] **Step 4: 更新进度和工作日志**

把 D10 更新为 100%，证据写明：服务端优先/本地降级、成人与儿童五维雷达、认知汇总、注意力趋势、空状态、数据来源、测试数量和提交。D11 保持未开始；D16、D17 保持暂缓，不把 PPT 记为完成。

- [ ] **Step 5: 提交进度记录**

```powershell
git add '项目任务与进度.md'
git diff --cached --check
git commit -m "docs: record comprehensive report completion"
```

- [ ] **Step 6: 最终状态检查**

Run:

```powershell
git status --short
git log -8 --oneline
```

Expected: 工作区干净；最近提交按纯逻辑、量表缓存、入口、控制器、视图、进度记录排列。
