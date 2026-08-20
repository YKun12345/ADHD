# Miniprogram ASRS Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 D4 ASRS 成人行为量表的原生小程序作答、草稿、提交、结果展示和成人首页入口。

**Architecture:** 题库与答案规则放在纯 CommonJS 模块，页面控制器只编排微信 storage、请求和导航。服务端负责医学算分；A 端不在本地生成风险结论，请求失败时保留草稿。

**Tech Stack:** 微信小程序原生 JavaScript/WXML/WXSS、Node `assert`、现有 `request.js`。

---

### Task 1: ASRS 题库与答案规则

**Files:**
- Create: `miniprogram/tests/asrs-scale.test.js`
- Create: `miniprogram/utils/asrs-scale.js`

- [ ] **Step 1: 写失败测试**

断言 18 题、五级选项 0—4、草稿从首个非法值截断、答案更新不修改原数组、进度为 1/18 到 18/18、未完成时不能生成 payload。

```js
assert.equal(ASRS_CONFIG.questions.length, 18)
assert.deepEqual(ASRS_CONFIG.options.map((item) => item.value), [0, 1, 2, 3, 4])
assert.deepEqual(normalizeDraftAnswers([0, 1, 9, 2]), [0, 1])
assert.equal(buildScalePayload(Array(17).fill(0)), null)
assert.deepEqual(buildScalePayload(Array(18).fill(0)), {
  scale_type: 'ASRS',
  respondent_type: 'self',
  answers: Array(18).fill(0)
})
```

- [ ] **Step 2: 运行红灯**

Run: `node miniprogram/tests/asrs-scale.test.js`

Expected: `MODULE_NOT_FOUND`。

- [ ] **Step 3: 最小实现**

导出：

```js
const ASRS_DRAFT_KEY = 'scale_draft_asrs'
const ASRS_CONFIG = { title, scaleType, respondentType, options, questions }
function normalizeDraftAnswers(value) {}
function setAnswer(answers, index, value) {}
function getQuestionState(index, answers) {}
function buildScalePayload(answers) {}
```

题目逐字迁移现有 `js/scale.js` 的成人 18 题，不扩写医学内容。

- [ ] **Step 4: 绿灯、语法和提交**

```powershell
node miniprogram/tests/asrs-scale.test.js
node --check miniprogram/utils/asrs-scale.js
git add miniprogram/tests/asrs-scale.test.js miniprogram/utils/asrs-scale.js
git commit -m "feat(miniprogram): add ASRS scale model"
```

### Task 2: ASRS 页面控制器

**Files:**
- Create: `miniprogram/tests/scale-page.test.js`
- Create: `miniprogram/pages/scale/index.js`
- Create: `miniprogram/pages/scale/index.json`

- [ ] **Step 1: 写页面失败测试**

mock `Page`、`wx`、`request`，验证成人初始化、儿童拦截、草稿恢复、选项保存、未答下一题拦截、上一题、最后一题提交、成功清草稿、失败保留草稿和 `submitting` 重复保护。

```js
assert.equal(adultPage.data.patientSupported, true)
assert.equal(childPage.data.patientSupported, false)
assert.deepEqual(calls.storageWrites.at(-1), [ASRS_DRAFT_KEY, [2]])
assert.deepEqual(calls.request.at(-1).data.answers, Array(18).fill(2))
assert.equal(failedPage.data.submitting, false)
```

- [ ] **Step 2: 运行红灯**

Run: `node miniprogram/tests/scale-page.test.js`

Expected: 页面模块不存在。

- [ ] **Step 3: 最小实现控制器**

`onLoad()` 读取当前用户类型并恢复草稿；`selectOption()` 保存当前答案；`goNext()` 和 `goPrevious()` 控制题号；最后一题调用 `submitScale()`；响应必须包含 `total_score/risk_level/summary/recommendations` 才能清草稿并显示结果。

请求固定为：

```js
request({
  url: '/patient/submit_scale',
  method: 'POST',
  data: buildScalePayload(this.data.answers)
})
```

- [ ] **Step 4: 绿灯、回归和提交**

```powershell
node miniprogram/tests/scale-page.test.js
node miniprogram/tests/asrs-scale.test.js
node --check miniprogram/pages/scale/index.js
git add miniprogram/tests/scale-page.test.js miniprogram/pages/scale/index.js miniprogram/pages/scale/index.json
git commit -m "feat(miniprogram): implement ASRS page logic"
```

### Task 3: ASRS 页面结构与样式

**Files:**
- Create: `miniprogram/tests/scale-view.test.js`
- Create: `miniprogram/pages/scale/index.wxml`
- Create: `miniprogram/pages/scale/index.wxss`

- [ ] **Step 1: 写视图失败测试**

断言成人标题、18 题进度、单题文本、五个选项、选中态、上一题/下一题/提交、儿童说明、结果摘要、建议列表和免责声明均存在。

```js
assert.match(wxml, /ASRS 成人自评量表/)
assert.match(wxml, /wx:for="\{\{options\}\}"/)
assert.match(wxml, /bindtap="selectOption"/)
assert.match(wxml, /本量表结果仅用于辅助筛查/)
assert.match(wxss, /\.option-button--selected/)
```

- [ ] **Step 2: 运行红灯**

Run: `node miniprogram/tests/scale-view.test.js`

Expected: WXML 文件不存在。

- [ ] **Step 3: 创建移动端单题界面**

WXML 分为不支持提示、答题状态和结果状态；按钮使用真实 `disabled/submitting`；当前选项由 `selectedValue` 控制；最后一题按钮文案为“提交量表”。WXSS 延续注册与首页的深蓝、青绿色和白色卡片视觉。

- [ ] **Step 4: 绿灯和提交**

```powershell
node miniprogram/tests/scale-view.test.js
node miniprogram/tests/scale-page.test.js
git diff --check
git add miniprogram/tests/scale-view.test.js miniprogram/pages/scale/index.wxml miniprogram/pages/scale/index.wxss
git commit -m "style(miniprogram): build ASRS question flow"
```

### Task 4: 注册路由并启用成人首页入口

**Files:**
- Modify: `miniprogram/tests/home-dashboard.test.js`
- Modify: `miniprogram/tests/home-page.test.js`
- Modify: `miniprogram/tests/home-view.test.js`
- Modify: `miniprogram/utils/home-dashboard.js`
- Modify: `miniprogram/pages/home/index.js`
- Modify: `miniprogram/app.json`

- [ ] **Step 1: 写入口失败测试**

传入成人患者类型时，量表任务和快捷入口必须 `available: true` 且 URL 为 `/pages/scale/index`；儿童患者仍不可用。页面 `onLoad` 必须根据 `current_user.patient_profile.patient_type` 构造入口，点击成人量表调用一次 `navigateTo`。

- [ ] **Step 2: 运行红灯**

```powershell
node miniprogram/tests/home-dashboard.test.js
node miniprogram/tests/home-page.test.js
```

Expected: 成人入口仍为不可用。

- [ ] **Step 3: 实现并注册路由**

`buildHomeTasks(patientType)` 与 `buildQuickEntries(patientType)` 只在 `patientType === 'adult'` 时给量表项增加 URL；`onLoad` 使用患者资料重建列表；`app.json` 添加 `pages/scale/index`。

- [ ] **Step 4: 回归和提交**

```powershell
node miniprogram/tests/home-dashboard.test.js
node miniprogram/tests/home-page.test.js
node miniprogram/tests/home-view.test.js
git add miniprogram/app.json miniprogram/utils/home-dashboard.js miniprogram/pages/home/index.js miniprogram/tests/home-dashboard.test.js miniprogram/tests/home-page.test.js miniprogram/tests/home-view.test.js
git commit -m "feat(miniprogram): enable adult ASRS entry"
```

### Task 5: D4 全量验证和工作记录

**Files:**
- Modify: `项目任务与进度.md`
- Modify: `docs/superpowers/plans/2026-08-21-miniprogram-asrs-scale.md`

- [ ] **Step 1: 运行全量 Node 测试和 JavaScript 语法检查**

```powershell
Get-ChildItem miniprogram/tests -Filter '*.test.js' | Sort-Object Name | ForEach-Object {
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Get-ChildItem miniprogram -Recurse -Filter '*.js' | ForEach-Object {
  node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
git diff --check
```

Expected: 全部通过。

- [ ] **Step 2: 更新记录**

把 D4 更新为 100%，记录实际测试数量、提交号、成人入口、儿童保护和“真实算分待 B 接口”的边界。重新计算 A 与总目标进度，不把未执行的微信开发者工具操作记为通过。

- [ ] **Step 3: 提交记录并确认干净**

```powershell
git add docs/superpowers/plans/2026-08-21-miniprogram-asrs-scale.md 项目任务与进度.md
git commit -m "docs: record ASRS scale completion"
git status --short
```

Expected: 工作区干净。

## 计划自审

- D4 只实现成人 ASRS，不提前声称 SNAP-IV 完成；
- 页面不实现 B 的医学算分；
- 成人和儿童入口分支都有测试；
- 草稿、边界、失败、重复提交和敏感信息均有处理；
- 题库、控制器、视图和首页入口分别经历红绿测试；
- 最终记录包含证据、边界和下一步 D5。
