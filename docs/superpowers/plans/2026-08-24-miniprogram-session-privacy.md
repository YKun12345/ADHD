# 微信小程序会话与本地数据隐私 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为所有患者业务页面增加统一会话保护，并提供经过二次确认的退出账号与本地患者数据清理功能。

**Architecture:** `session-privacy.js` 以明确白名单管理会话键与患者数据键；`patient-page.js` 包装所有受保护页面生命周期，阻止残缺会话读取数据。独立的账号与隐私页只显示本地数据数量，删除时保留服务器地址并明确说明不影响后端数据。

**Tech Stack:** 微信小程序原生 JavaScript/WXML/WXSS、Node.js `assert` 测试、Git worktree。

---

### Task 1: 会话与患者数据纯逻辑

**Files:**
- Create: `miniprogram/utils/session-privacy.js`
- Create: `miniprogram/tests/session-privacy.test.js`

- [x] **Step 1: 写会失败的会话和数据边界测试**

测试必须先引用尚不存在的模块，并覆盖以下期望 API：

```js
const {
  SESSION_KEYS,
  PATIENT_DATA_KEYS,
  hasValidPatientSession,
  summarizePatientData,
  clearPatientData,
  endPatientSession,
  ensurePatientSession
} = require('../utils/session-privacy')

assert.deepEqual(SESSION_KEYS, ['access_token', 'current_user'])
assert.equal(PATIENT_DATA_KEYS.includes('api_base_url'), false)
assert.equal(hasValidPatientSession(readValidStorage), true)
assert.equal(hasValidPatientSession(readMissingToken), false)
assert.equal(hasValidPatientSession(readMissingUser), false)
assert.deepEqual(summarizePatientData(readPopulatedStorage), {
  draftCount: 2,
  resultCount: 3,
  trackingDayCount: 2,
  pendingCount: 4,
  totalLocalItems: 11
})
```

再验证 `clearPatientData(remove)` 只删除九个患者键，`endPatientSession()` 额外删除两个会话键但不删除 `api_base_url`，以及单次调用 `ensurePatientSession()` 在无效会话下会重启登录并返回 `false`。页面生命周期的重复跳转由 Task 2 包装器拦截。

- [x] **Step 2: 运行测试确认因模块缺失而失败**

Run: `node miniprogram/tests/session-privacy.test.js`  
Expected: FAIL，提示找不到 `../utils/session-privacy`。

- [x] **Step 3: 实现纯逻辑与微信运行时适配**

创建常量：

```js
const SESSION_KEYS = ['access_token', 'current_user']
const PATIENT_DATA_KEYS = [
  'patient_dashboard_cache',
  'scale_draft_asrs',
  'scale_draft_snap_iv',
  'scale_latest_result',
  'cognitive_latest_results',
  'pending_cognitive_result',
  'pending_stroop_result',
  'tracking_local_logs',
  'tracking_pending_logs'
]
```

实现以下签名，不使用 `wx.clearStorageSync()`：

```js
function hasValidPatientSession(readStorage = defaultReadStorage) {}
function summarizePatientData(readStorage = defaultReadStorage) {}
function clearPatientData(removeStorage = defaultRemoveStorage) {}
function endPatientSession(options = {}) {}
function ensurePatientSession(options = {}) {}
```

`summarizePatientData()` 的规则：两个草稿各计一项；量表最近结果计一项；认知最近结果按有效对象键数计数；追踪日志按有效数组长度计数；两个认知待同步结果各计一项；追踪待同步对象按键数计数。`endPatientSession()` 默认删除患者数据和会话，调用可注入的 `setLoggedIn(false)`；`ensurePatientSession()` 无效时调用结束会话并 `reLaunch('/pages/login/index')`。

- [x] **Step 4: 验证纯逻辑转绿并检查语法**

Run:

```powershell
node miniprogram/tests/session-privacy.test.js
node --check miniprogram/utils/session-privacy.js
```

Expected: 显示“会话与本地数据隐私测试全部通过”，语法检查退出码为 0。

- [x] **Step 5: 精确提交**

```powershell
git add miniprogram/utils/session-privacy.js miniprogram/tests/session-privacy.test.js
git commit -m "feat(miniprogram): centralize patient session privacy"
```

### Task 2: 患者页面统一包装器

**Files:**
- Create: `miniprogram/utils/patient-page.js`
- Create: `miniprogram/tests/patient-page.test.js`
- Create: `miniprogram/tests/protected-pages.test.js`
- Modify: `miniprogram/pages/home/index.js`
- Modify: `miniprogram/pages/scale/index.js`
- Modify: `miniprogram/pages/cognitive-center/index.js`
- Modify: `miniprogram/pages/cognitive/index.js`
- Modify: `miniprogram/pages/stroop/index.js`
- Modify: `miniprogram/pages/tracking/index.js`
- Modify: `miniprogram/pages/tracking-trend/index.js`
- Modify: `miniprogram/pages/report/index.js`
- Modify: `miniprogram/pages/ai-chat/index.js`
- Modify: `miniprogram/pages/care-pathway/index.js`
- Modify: `miniprogram/pages/education/index.js`
- Modify: `miniprogram/pages/education-detail/index.js`
- Modify: affected page-controller tests under `miniprogram/tests/`

- [x] **Step 1: 写包装器生命周期失败测试**

`patient-page.test.js` 通过 `protectPatientPage(definition, guard)` 验证：

```js
const protectedDefinition = protectPatientPage({
  onLoad(options) { calls.push(['load', this, options]); return 'loaded' },
  onShow(value) { calls.push(['show', this, value]); return 'shown' },
  customAction() { return 'kept' }
}, guard)
```

有效会话必须保留 `this`、参数、返回值和自定义方法；无效会话不得调用原 `onLoad/onShow`；没有原生命周期的页面也必须被保护。

`protected-pages.test.js` 读取十二个受保护页面源码，要求导入并调用 `registerPatientPage`；同时确认登录、注册和服务器设置仍使用公开 `Page()`。

- [x] **Step 2: 运行测试确认包装器和页面接入均失败**

Run:

```powershell
node miniprogram/tests/patient-page.test.js
node miniprogram/tests/protected-pages.test.js
```

Expected: 第一个测试因模块缺失失败，第二个测试列出尚未使用包装器的页面。

- [x] **Step 3: 实现包装器**

`patient-page.js` 导出：

```js
function protectPatientPage(definition, guard = ensurePatientSession) {
  const originalOnLoad = definition.onLoad
  const originalOnShow = definition.onShow
  return {
    ...definition,
    onLoad(...args) {
      this.__patientSessionAllowed = guard()
      if (!this.__patientSessionAllowed) return undefined
      return originalOnLoad ? originalOnLoad.apply(this, args) : undefined
    },
    onShow(...args) {
      if (this.__patientSessionAllowed === false) return undefined
      this.__patientSessionAllowed = guard()
      if (!this.__patientSessionAllowed) return undefined
      return originalOnShow ? originalOnShow.apply(this, args) : undefined
    }
  }
}

function registerPatientPage(definition) {
  Page(protectPatientPage(definition))
}
```

- [x] **Step 4: 明确接入所有受保护页面**

在十二个页面顶部加入对应相对路径的导入，并把唯一的 `Page({` 改为 `registerPatientPage({`。例如一级页面目录统一使用：

```js
const { registerPatientPage } = require('../../utils/patient-page')
```

登录、注册、服务器设置不得修改为受保护页面。为既有页面测试的 storage fixture 补充 `access_token: 'test-token'`，让测试真实通过统一守卫。

- [x] **Step 5: 验证包装器、静态接入和全部受影响页面测试**

Run:

```powershell
node miniprogram/tests/patient-page.test.js
node miniprogram/tests/protected-pages.test.js
node miniprogram/tests/home-page.test.js
node miniprogram/tests/scale-page.test.js
node miniprogram/tests/cognitive-center-page.test.js
node miniprogram/tests/cognitive-page.test.js
node miniprogram/tests/stroop-page.test.js
node miniprogram/tests/tracking-page.test.js
node miniprogram/tests/tracking-trend-page.test.js
node miniprogram/tests/report-page.test.js
node miniprogram/tests/ai-chat-page.test.js
node miniprogram/tests/care-pathway-page.test.js
node miniprogram/tests/education-pages.test.js
```

Expected: 全部通过，且无额外 `reLaunch`。

- [x] **Step 6: 精确提交**

只暂存包装器、两个新测试、十二个页面控制器和确实需要 token fixture 的测试：

```powershell
git commit -m "feat(miniprogram): guard patient pages"
```

### Task 3: 账号与隐私页面控制逻辑

**Files:**
- Create: `miniprogram/pages/privacy-settings/index.js`
- Create: `miniprogram/pages/privacy-settings/index.json`
- Create: `miniprogram/tests/privacy-settings-page.test.js`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/pages/home/index.js`
- Modify: `miniprogram/tests/home-page.test.js`
- Modify: `miniprogram/tests/protected-pages.test.js`

- [x] **Step 1: 写页面控制失败测试**

测试先断言页面控制器存在，再通过注入/缓存模块捕获 Page 定义。覆盖：

```js
page.onLoad()
assert.equal(page.data.patientName, '隐私测试患者')
assert.equal(page.data.pendingCount, 4)

await page.clearLocalData()
assert.equal(cancelledRemovalCount, 0)

await confirmedPage.clearLocalData()
assert.equal(confirmedPage.data.totalLocalItems, 0)
assert.equal(storage.api_base_url, 'https://api.example.com/api/v1')

await confirmedPage.logout()
assert.deepEqual(reLaunchCalls, [{ url: '/pages/login/index' }])
```

同时验证快速重复点击只打开一次确认框、确认框失败不删除、清理数据保持会话、退出删除会话。

- [x] **Step 2: 运行测试确认页面缺失失败**

Run: `node miniprogram/tests/privacy-settings-page.test.js`  
Expected: FAIL，提示账号与隐私页面尚未创建。

- [x] **Step 3: 实现页面控制器**

页面使用 `registerPatientPage`，数据结构固定为：

```js
data: {
  patientName: '患者',
  draftCount: 0,
  resultCount: 0,
  trackingDayCount: 0,
  pendingCount: 0,
  totalLocalItems: 0,
  acting: false
}
```

实现 `refreshSummary()`、返回 Promise 的 `_confirm(options)`、`clearLocalData()`、`logout()` 和 `goBack()`。取消或弹窗失败时必须恢复 `acting:false`；确认清理后刷新摘要；确认退出后调用统一 `endPatientSession()` 并 `wx.reLaunch`。

- [x] **Step 4: 登记路由和首页入口**

在 `app.json` 登记 `pages/privacy-settings/index`。首页增加：

```js
openPrivacySettings() {
  wx.navigateTo({ url: '/pages/privacy-settings/index' })
}
```

在首页控制测试中验证唯一导航目标，并把新页面加入受保护页面静态测试。

- [x] **Step 5: 验证页面与入口逻辑**

Run:

```powershell
node miniprogram/tests/privacy-settings-page.test.js
node miniprogram/tests/home-page.test.js
node miniprogram/tests/protected-pages.test.js
node --check miniprogram/pages/privacy-settings/index.js
```

Expected: 全部通过。

- [x] **Step 6: 精确提交**

```powershell
git add miniprogram/app.json miniprogram/pages/privacy-settings/index.js miniprogram/pages/privacy-settings/index.json miniprogram/pages/home/index.js miniprogram/tests/privacy-settings-page.test.js miniprogram/tests/home-page.test.js miniprogram/tests/protected-pages.test.js
git commit -m "feat(miniprogram): add account privacy controls"
```

### Task 4: 账号与隐私页面视图

**Files:**
- Create: `miniprogram/pages/privacy-settings/index.wxml`
- Create: `miniprogram/pages/privacy-settings/index.wxss`
- Create: `miniprogram/tests/privacy-settings-view.test.js`
- Modify: `miniprogram/pages/home/index.wxml`
- Modify: `miniprogram/pages/home/index.wxss`
- Modify: `miniprogram/tests/home-view.test.js`

- [x] **Step 1: 写视图结构失败测试**

测试要求 WXML 包含患者名称、四类数量、待同步警示、`clearLocalData`、`logout`、`goBack`、二次确认说明、“不会删除服务器数据”和医学免责声明；要求 WXSS 包含摘要卡、危险操作区、删除按钮、退出按钮及按钮内容 flex 居中；首页必须有“账号与隐私”入口。

- [x] **Step 2: 运行测试确认视图缺失失败**

Run:

```powershell
node miniprogram/tests/privacy-settings-view.test.js
node miniprogram/tests/home-view.test.js
```

Expected: FAIL，明确列出缺失文件或片段。

- [x] **Step 3: 实现 WXML/WXSS**

页面顺序固定为：标题与患者名 → 本地数据摘要四格 → 待同步警示 → 隐私说明 → 清理按钮 → 退出按钮 → 医疗提示 → 返回上一页。危险按钮使用红色边框而非夸张实心红色，两个按钮都使用：

```css
display: flex;
align-items: center;
justify-content: center;
```

首页在现有“服务器设置”附近增加低强调度“账号与隐私”入口，不新增 tabBar。

- [x] **Step 4: 验证视图和现有首页结构**

Run:

```powershell
node miniprogram/tests/privacy-settings-view.test.js
node miniprogram/tests/home-view.test.js
git diff --check
```

Expected: 全部通过；只允许 LF/CRLF 提示，不得有空白错误。

- [x] **Step 5: 精确提交**

```powershell
git add miniprogram/pages/privacy-settings/index.wxml miniprogram/pages/privacy-settings/index.wxss miniprogram/pages/home/index.wxml miniprogram/pages/home/index.wxss miniprogram/tests/privacy-settings-view.test.js miniprogram/tests/home-view.test.js
git commit -m "feat(miniprogram): build account privacy view"
```

### Task 5: 401 统一清理、全量验证与记录

**Files:**
- Modify: `miniprogram/utils/request.js`
- Modify: `miniprogram/tests/register-error.test.js`
- Modify: `miniprogram/app.js`
- Modify: `miniprogram/utils/session-privacy.js`
- Modify: `miniprogram/tests/session-privacy.test.js`
- Modify: `miniprogram/tests/runtime-compatibility.test.js`
- Modify: `miniprogram/tests/privacy-settings-page.test.js`
- Create: `miniprogram/tests/app-session.test.js`
- Modify: `项目任务与进度.md`
- Modify: `docs/superpowers/plans/2026-08-24-miniprogram-session-privacy.md`

- [x] **Step 1: 写 401 与 App 会话失败测试**

扩展请求测试：带 token 的业务请求收到 401 时，应删除两个会话键和九个患者键、保留 `api_base_url`、清空内存用户、返回登录并继续抛出带 `statusCode:401` 的错误；`skipAuth` 请求不得触发退出清理。新增 App 测试，要求 `onLaunch()` 只有在 token 与患者资料同时有效时才把 `globalData.isLoggedIn` 设为 `true` 并恢复 `globalData.userInfo`；残缺会话必须清除患者数据和会话、保留服务器地址并把内存用户置空。扩展会话模块测试，要求默认结束会话同时清空 `globalData.userInfo`；同步把账号与隐私页退出后的旧断言升级为 `userInfo === null`，这是安全契约升级而非放宽测试。

- [x] **Step 2: 运行测试确认旧行为失败**

Run:

```powershell
node miniprogram/tests/register-error.test.js
node miniprogram/tests/app-session.test.js
```

Expected: 请求测试显示患者键或内存用户未清除；App 测试显示只检查 token、未清理残缺会话或未恢复有效用户。

- [x] **Step 3: 复用统一会话逻辑**

`request.js` 导入 `endPatientSession`，在 `response.statusCode === 401 && token && !options.skipAuth` 时调用它，再 `wx.reLaunch`。`session-privacy.js` 的默认全局状态更新在退出时同时清空 `userInfo`。`app.js` 导入 `hasValidPatientSession` 与 `endPatientSession`：有效会话恢复登录状态和内存用户；无效会话使用统一结束逻辑清患者数据与会话但不额外跳转，不复制判断规则。

- [x] **Step 4: 运行目标测试和完整自动验证**

依次执行：

```powershell
node miniprogram/tests/register-error.test.js
node miniprogram/tests/app-session.test.js

$tests = Get-ChildItem -LiteralPath 'miniprogram/tests' -Filter '*.test.js' | Sort-Object Name
foreach ($test in $tests) {
  node $test.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$javascriptFiles = Get-ChildItem -LiteralPath 'miniprogram' -Recurse -Filter '*.js'
foreach ($file in $javascriptFiles) {
  node --check $file.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$jsonFiles = Get-ChildItem -LiteralPath 'miniprogram' -Recurse -Filter '*.json'
foreach ($file in $jsonFiles) {
  Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8 | ConvertFrom-Json | Out-Null
}

git diff --check
```

Expected: 全部测试、JS、JSON 和 Git 空白检查退出码为 0。

- [x] **Step 5: 执行路由、事件、边界和用户文件保护检查**

确认全部 app 路由文件齐全、所有 WXML `bind*` 方法存在、生产代码未引入 `.at(`、`Object.hasOwn(` 或 `Promise.prototype.finally`、变更中没有 `backend/` 或医生 Web 文件，并确认主工作区 `miniprogram/utils/register-validation.js` SHA-256 仍为开发开始前记录值。

- [x] **Step 6: 更新进度和工作日志**

在 `项目任务与进度.md` 新增“会话与隐私安全收尾”记录，写明测试数量、清理白名单、服务器地址保留和真机确认仍待 A；不得把未执行的真机点击记为完成。

复审加固实际补充：认证请求使用页面活动状态、操作代次、患者数据修订号和 API 来源租约阻止旧响应写回；新凭证与 App 内存态统一提交，失败时回滚；切换服务器前必须完整结束旧来源会话；当前会话 401、退出和服务器切换均区分凭证残留、页面清空失败及导航失败；安全跳转统一处理同步异常和异步失败。最终在功能分支和合并后的 `main` 均通过 53 个测试文件、94 个 JavaScript 文件语法检查、全部 JSON 解析、16 条路由和 92 个 WXML 事件绑定检查。

- [x] **Step 7: 提交并完成分支集成**

```powershell
git add miniprogram/utils/request.js miniprogram/app.js miniprogram/utils/session-privacy.js miniprogram/tests/register-error.test.js miniprogram/tests/app-session.test.js miniprogram/tests/session-privacy.test.js miniprogram/tests/runtime-compatibility.test.js miniprogram/tests/privacy-settings-page.test.js 项目任务与进度.md docs/superpowers/plans/2026-08-24-miniprogram-session-privacy.md
git commit -m "feat(miniprogram): finish session privacy safeguards"
```

使用 `superpowers:verification-before-completion` 和 `superpowers:finishing-a-development-branch`，在合并后的 `main` 再运行完整测试，最后才清理工作树。
