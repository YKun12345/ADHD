# 微信小程序浮动 AI Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正儿童 SNAP-IV 未答完时的题数提示，并在 11 个患者业务页面提供可展开、可预填使用问题、可自由提问且不会自动发送的浮动 AI Copilot。

**Architecture:** 使用 `utils/ai-copilot.js` 保存页面白名单、静态建议和 AI 路由构造逻辑，原生 `components/ai-copilot` 只负责显示状态和微信导航。现有 AI 助手通过可选 `prompt` 参数预填输入框，继续调用既有 `/api/v1/ai/chat`，不修改后端或保存外部 AI 密钥。

**Tech Stack:** 微信原生小程序 WXML/WXSS/CommonJS、Node.js `node:assert/strict` 测试、PowerShell、Git。

---

## 执行前边界

- 在执行本计划前使用 `superpowers:using-git-worktrees` 创建 `.worktrees/feature-ai-copilot` 隔离工作树和 `feature/ai-copilot` 分支。
- 主工作区现有用户改动 `miniprogram/utils/register-validation.js` 不得修改、暂存、重置、检出或删除。执行前主工作区 SHA-256 为 `E57487BEE100A4C52F593C280CD16CF9E5D776BE6C173933D2232C1AE699F094`，合并后必须再次核对。
- 不修改 `backend/`、医生 Web、模型、数据库、部署、PPT 或汇报材料。
- 每个任务严格执行 RED → GREEN → 回归 → 精确提交；不得先写生产代码。

## 文件结构

**新增：**

- `miniprogram/utils/ai-copilot.js`：11 页静态配置、白名单和 AI 页面 URL 构造。
- `miniprogram/components/ai-copilot/index.js`：组件状态、配置读取和导航编排。
- `miniprogram/components/ai-copilot/index.json`：原生组件声明。
- `miniprogram/components/ai-copilot/index.wxml`：浮动按钮和紧凑提示卡。
- `miniprogram/components/ai-copilot/index.wxss`：固定定位、安全区和卡片视觉。
- `miniprogram/tests/ai-copilot.test.js`：纯配置与 URL 测试。
- `miniprogram/tests/ai-copilot-component.test.js`：组件控制逻辑和静态结构测试。
- `miniprogram/tests/ai-copilot-wiring.test.js`：11 页接线与排除页面测试。

**修改：**

- `miniprogram/pages/scale/index.js`、`miniprogram/tests/scale-page.test.js`：动态题数提示。
- `miniprogram/utils/ai-chat.js`、`miniprogram/pages/ai-chat/index.js`、`miniprogram/pages/ai-chat/index.wxml`、`miniprogram/tests/ai-chat.test.js`、`miniprogram/tests/ai-chat-page.test.js`、`miniprogram/tests/ai-chat-view.test.js`：安全预填、无自动发送及输入提示。
- 11 个页面的 `index.json` 与 `index.wxml`：声明并渲染 Copilot。
- `项目任务与进度.md`：记录范围、测试证据、提交和 B 职责边界。
- 本计划文件：执行时勾选步骤并记录实际结果。

### Task 1: 修正儿童量表未完成提示

**Files:**

- Modify: `miniprogram/tests/scale-page.test.js`
- Modify: `miniprogram/pages/scale/index.js:202-216`

- [x] **Step 1: 写儿童 26 题失败测试**

在 `childPage` 初始化断言之后加入：

```js
  reset('child')
  const incompleteChildPage = createPage()
  incompleteChildPage.onLoad()
  await incompleteChildPage.submitScale()
  assert.deepEqual(calls.toasts.at(-1), {
    title: '请完成全部26道题目',
    icon: 'none'
  })
  assert.equal(incompleteChildPage.data.currentIndex, 0)
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `node miniprogram/tests/scale-page.test.js`

Expected: FAIL，实际标题为“请完成全部18道题目”，期望为“请完成全部26道题目”。

- [x] **Step 3: 写最小动态题数实现**

将 `submitScale()` 的硬编码 toast 攂为：

```js
      const totalQuestions = Number.isInteger(this.data.totalQuestions)
        ? this.data.totalQuestions
        : this.scaleModel.config.questions.length
      wx.showToast({
        title: `请完成全部${totalQuestions}道题目`,
        icon: 'none'
      })
```

- [x] **Step 4: 验证成人和儿童均通过**

在同一测试中补充成人未完成断言：

```js
  reset('adult')
  const incompleteAdultPage = createPage()
  incompleteAdultPage.onLoad()
  await incompleteAdultPage.submitScale()
  assert.equal(calls.toasts.at(-1).title, '请完成全部18道题目')
```

Run: `node miniprogram/tests/scale-page.test.js`

Expected: `ASRS 页面控制逻辑测试全部通过`。

- [x] **Step 5: 语法检查并提交**

```powershell
node --check miniprogram/pages/scale/index.js
node --check miniprogram/tests/scale-page.test.js
git diff --check -- miniprogram/pages/scale/index.js miniprogram/tests/scale-page.test.js
git add miniprogram/pages/scale/index.js miniprogram/tests/scale-page.test.js
git commit -m "fix(miniprogram): show active scale question count"
```

Expected: 两个 `node --check` 无输出，差异检查无错误，只提交以上两个文件。

### Task 2: 建立 Copilot 页面配置和安全路由

**Files:**

- Create: `miniprogram/tests/ai-copilot.test.js`
- Create: `miniprogram/utils/ai-copilot.js`

- [x] **Step 1: 写配置模块失败测试**

创建测试，完整覆盖页面键、配置、通用回退、自由提问和编码：

```js
const assert = require('node:assert/strict')
const {
  COPILOT_PAGE_KEYS,
  getCopilotConfig,
  buildAiChatUrl
} = require('../utils/ai-copilot')

const expectedKeys = [
  'home',
  'scale',
  'cognitive-center',
  'cognitive',
  'stroop',
  'tracking',
  'tracking-trend',
  'report',
  'care-pathway',
  'education',
  'education-detail'
]

assert.deepEqual(COPILOT_PAGE_KEYS, expectedKeys)
for (const pageKey of expectedKeys) {
  const config = getCopilotConfig(pageKey)
  assert.equal(config.pageKey, pageKey)
  assert.equal(Boolean(config.title), true)
  assert.equal(Boolean(config.advice), true)
  assert.equal(Boolean(config.helpPrompt), true)
  assert.equal(config.helpPrompt.length <= 4000, true)
  const url = buildAiChatUrl(pageKey, 'help')
  assert.match(url, /^\/pages\/ai-chat\/index\?scope=general&prompt=/)
  assert.equal(decodeURIComponent(url.split('prompt=')[1]), config.helpPrompt)
}

assert.equal(getCopilotConfig('unknown').pageKey, 'general')
assert.equal(
  buildAiChatUrl('home', 'free'),
  '/pages/ai-chat/index?scope=general'
)
assert.equal(
  buildAiChatUrl('home', 'invalid'),
  '/pages/ai-chat/index?scope=general'
)
assert.match(buildAiChatUrl('scale', 'help'), /%E8%AF%B7/)

console.log('AI Copilot 页面配置测试全部通过')
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `node miniprogram/tests/ai-copilot.test.js`

Expected: FAIL，包含 `Cannot find module '../utils/ai-copilot'`。

- [x] **Step 3: 写页面白名单和纯配置**

创建 `miniprogram/utils/ai-copilot.js`：

```js
const MAX_PROMPT_LENGTH = 4000

const COPILOT_PAGE_KEYS = Object.freeze([
  'home',
  'scale',
  'cognitive-center',
  'cognitive',
  'stroop',
  'tracking',
  'tracking-trend',
  'report',
  'care-pathway',
  'education',
  'education-detail'
])

const GENERAL_CONFIG = Object.freeze({
  pageKey: 'general',
  title: '当前页面',
  advice: '可以询问本页操作方法或健康相关问题。',
  helpPrompt: '请介绍当前页面应该怎样使用。'
})

const PAGE_CONFIGS = Object.freeze({
  home: {
    pageKey: 'home',
    title: '患者首页',
    advice: '按当天任务顺序完成量表、测试和追踪。',
    helpPrompt: '请介绍患者首页的任务、进度和快捷入口应该怎样使用。'
  },
  scale: {
    pageKey: 'scale',
    title: '量表页面',
    advice: '按近期真实情况逐题选择，提交前检查漏答。',
    helpPrompt: '请告诉我如何完成当前量表，以及漏答后应该怎么检查。'
  },
  'cognitive-center': {
    pageKey: 'cognitive-center',
    title: '认知测试中心',
    advice: '先阅读说明，再在安静环境中开始测试。',
    helpPrompt: '请介绍认知测试中心的入口、测试顺序和注意事项。'
  },
  cognitive: {
    pageKey: 'cognitive',
    title: 'Go/No-Go 测试',
    advice: '保持注意，按页面规则完成测试。',
    helpPrompt: '请用简单步骤说明 Go/No-Go 测试怎样操作。'
  },
  stroop: {
    pageKey: 'stroop',
    title: 'Stroop 测试',
    advice: '根据当前规则作答，尽量兼顾准确和稳定。',
    helpPrompt: '请用简单步骤说明 Stroop 测试怎样操作。'
  },
  tracking: {
    pageKey: 'tracking',
    title: '每日追踪',
    advice: '如实记录当天睡眠、情绪和用药情况。',
    helpPrompt: '请说明每日追踪每一项应该怎样填写。'
  },
  'tracking-trend': {
    pageKey: 'tracking-trend',
    title: '追踪趋势',
    advice: '结合多日变化看趋势，不根据单日数据下结论。',
    helpPrompt: '请告诉我怎样查看和理解追踪趋势页面。'
  },
  report: {
    pageKey: 'report',
    title: '综合报告',
    advice: '综合报告用于辅助了解情况，不替代医生诊断。',
    helpPrompt: '请介绍综合报告各部分的含义和查看方法。'
  },
  'care-pathway': {
    pageKey: 'care-pathway',
    title: '照护路径',
    advice: '按阶段查看建议，并在需要时联系专业人员。',
    helpPrompt: '请告诉我怎样使用照护路径页面安排下一步。'
  },
  education: {
    pageKey: 'education',
    title: '科普教育',
    advice: '优先阅读与当前任务相关的健康教育内容。',
    helpPrompt: '请介绍科普教育列表应该怎样查找和阅读内容。'
  },
  'education-detail': {
    pageKey: 'education-detail',
    title: '科普详情',
    advice: '阅读后可返回列表继续选择其他主题。',
    helpPrompt: '请介绍科普详情页内容应该怎样阅读和使用。'
  }
})

function getCopilotConfig(pageKey) {
  const config = PAGE_CONFIGS[pageKey] || GENERAL_CONFIG
  return { ...config }
}

function buildAiChatUrl(pageKey, mode = 'free') {
  const baseUrl = '/pages/ai-chat/index?scope=general'
  if (mode !== 'help') return baseUrl
  const prompt = getCopilotConfig(pageKey).helpPrompt.slice(0, MAX_PROMPT_LENGTH)
  return `${baseUrl}&prompt=${encodeURIComponent(prompt)}`
}

module.exports = {
  COPILOT_PAGE_KEYS,
  getCopilotConfig,
  buildAiChatUrl
}
```

- [x] **Step 4: 运行测试并确认 GREEN**

Run: `node miniprogram/tests/ai-copilot.test.js`

Expected: `AI Copilot 页面配置测试全部通过`。

- [x] **Step 5: 兼容性、语法与提交**

```powershell
node --check miniprogram/utils/ai-copilot.js
node --check miniprogram/tests/ai-copilot.test.js
node miniprogram/tests/runtime-compatibility.test.js
git diff --check -- miniprogram/utils/ai-copilot.js miniprogram/tests/ai-copilot.test.js
git add miniprogram/utils/ai-copilot.js miniprogram/tests/ai-copilot.test.js
git commit -m "feat(miniprogram): define AI copilot guidance"
```

Expected: Copilot 和旧微信内核兼容测试通过，只提交配置模块及测试。

### Task 3: 实现原生浮动 Copilot 组件

**Files:**

- Create: `miniprogram/tests/ai-copilot-component.test.js`
- Create: `miniprogram/components/ai-copilot/index.js`
- Create: `miniprogram/components/ai-copilot/index.json`
- Create: `miniprogram/components/ai-copilot/index.wxml`
- Create: `miniprogram/components/ai-copilot/index.wxss`

- [x] **Step 1: 写组件失败测试**

创建测试，用 `global.Component` 捕获组件定义，并读取 WXML/WXSS/JSON：

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const calls = { navigation: [], toasts: [] }
let componentDefinition
let navigationShouldFail = false

global.wx = {
  navigateTo(options) {
    calls.navigation.push(options.url)
    if (navigationShouldFail) options.fail()
    else options.success()
  },
  showToast(options) {
    calls.toasts.push(options)
  }
}
global.Component = (definition) => {
  componentDefinition = definition
}

require('../components/ai-copilot/index')

function createComponent(pageKey = 'scale') {
  return {
    data: { ...componentDefinition.data, pageKey },
    setData(patch) {
      this.data = { ...this.data, ...patch }
    },
    ...componentDefinition.methods
  }
}

const component = createComponent()
componentDefinition.lifetimes.attached.call(component)
assert.equal(component.data.expanded, false)
assert.equal(component.data.config.pageKey, 'scale')
component.togglePanel()
assert.equal(component.data.expanded, true)
component.closePanel()
assert.equal(component.data.expanded, false)

component.openPageHelp()
assert.match(calls.navigation[0], /scope=general&prompt=/)
assert.equal(component.data.expanded, false)
component.openFreeQuestion()
assert.equal(calls.navigation[1], '/pages/ai-chat/index?scope=general')

navigationShouldFail = true
component.togglePanel()
component.openFreeQuestion()
assert.equal(component.data.expanded, true)
assert.deepEqual(calls.toasts.at(-1), {
  title: '暂时无法打开AI助手',
  icon: 'none'
})

const directory = path.join(__dirname, '..', 'components', 'ai-copilot')
const json = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'))
const wxml = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8')
assert.equal(json.component, true)
for (const fragment of [
  'bindtap="togglePanel"',
  'wx:if="{{expanded}}"',
  '{{config.title}}',
  '{{config.advice}}',
  'bindtap="closePanel"',
  'bindtap="openPageHelp"',
  'bindtap="openFreeQuestion"',
  '如何使用本页',
  '自己提问'
]) assert.equal(wxml.includes(fragment), true, `WXML 缺少：${fragment}`)
for (const fragment of [
  '.ai-copilot',
  'position: fixed',
  'env(safe-area-inset-bottom)',
  '.ai-copilot__panel',
  '.ai-copilot__trigger'
]) assert.equal(wxss.includes(fragment), true, `WXSS 缺少：${fragment}`)

console.log('AI Copilot 组件测试全部通过')
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `node miniprogram/tests/ai-copilot-component.test.js`

Expected: FAIL，包含 `Cannot find module '../components/ai-copilot/index'`。

- [x] **Step 3: 实现组件控制器和声明**

`index.json`：

```json
{
  "component": true,
  "usingComponents": {}
}
```

`index.js`：

```js
const {
  getCopilotConfig,
  buildAiChatUrl
} = require('../../utils/ai-copilot')

Component({
  properties: {
    pageKey: {
      type: String,
      value: ''
    }
  },
  data: {
    expanded: false,
    config: getCopilotConfig('')
  },
  lifetimes: {
    attached() {
      this.setData({
        config: getCopilotConfig(this.data.pageKey)
      })
    }
  },
  methods: {
    togglePanel() {
      this.setData({ expanded: !this.data.expanded })
    },
    closePanel() {
      this.setData({ expanded: false })
    },
    openPageHelp() {
      this.navigateToAi(buildAiChatUrl(this.data.pageKey, 'help'))
    },
    openFreeQuestion() {
      this.navigateToAi(buildAiChatUrl(this.data.pageKey, 'free'))
    },
    navigateToAi(url) {
      wx.navigateTo({
        url,
        success: () => this.setData({ expanded: false }),
        fail: () => wx.showToast({
          title: '暂时无法打开AI助手',
          icon: 'none'
        })
      })
    }
  }
})
```

- [x] **Step 4: 实现紧凑卡片结构和固定布局**

`index.wxml`：

```xml
<view class="ai-copilot">
  <view class="ai-copilot__panel" wx:if="{{expanded}}">
    <view class="ai-copilot__header">
      <text class="ai-copilot__title">{{config.title}}</text>
      <view class="ai-copilot__close" bindtap="closePanel">×</view>
    </view>
    <text class="ai-copilot__advice">{{config.advice}}</text>
    <view class="ai-copilot__actions">
      <view class="ai-copilot__action ai-copilot__action--primary" bindtap="openPageHelp">如何使用本页</view>
      <view class="ai-copilot__action ai-copilot__action--secondary" bindtap="openFreeQuestion">自己提问</view>
    </view>
    <text class="ai-copilot__notice">AI仅提供辅助信息，不替代医生诊断</text>
  </view>
  <view class="ai-copilot__trigger" bindtap="togglePanel">
    <text>AI</text>
  </view>
</view>
```

`index.wxss`：

```css
.ai-copilot {
  position: fixed;
  right: 28rpx;
  bottom: calc(32rpx + env(safe-area-inset-bottom));
  z-index: 1200;
  display: flex;
  align-items: flex-end;
  flex-direction: column;
}

.ai-copilot__panel {
  width: 430rpx;
  margin-bottom: 18rpx;
  padding: 26rpx;
  box-sizing: border-box;
  border: 1rpx solid #d6e4e8;
  border-radius: 24rpx;
  color: #17324d;
  background: #ffffff;
  box-shadow: 0 16rpx 48rpx rgba(23, 50, 77, 0.18);
}

.ai-copilot__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ai-copilot__title {
  font-size: 28rpx;
  font-weight: 700;
}

.ai-copilot__close {
  width: 48rpx;
  height: 48rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6d8192;
  font-size: 40rpx;
}

.ai-copilot__advice,
.ai-copilot__notice {
  display: block;
}

.ai-copilot__advice {
  margin-top: 14rpx;
  color: #526c82;
  font-size: 23rpx;
  line-height: 1.6;
}

.ai-copilot__actions {
  display: flex;
  gap: 12rpx;
  margin-top: 22rpx;
}

.ai-copilot__action {
  min-width: 0;
  height: 66rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  box-sizing: border-box;
  border-radius: 16rpx;
  font-size: 22rpx;
  font-weight: 600;
}

.ai-copilot__action--primary {
  color: #ffffff;
  background: #17324d;
}

.ai-copilot__action--secondary {
  border: 1rpx solid #74a6a2;
  color: #2f716d;
  background: #edf7f5;
}

.ai-copilot__notice {
  margin-top: 16rpx;
  color: #8a9aa8;
  font-size: 18rpx;
  line-height: 1.5;
}

.ai-copilot__trigger {
  width: 92rpx;
  height: 92rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 4rpx solid rgba(255, 255, 255, 0.92);
  border-radius: 50%;
  color: #ffffff;
  background: #2f716d;
  box-shadow: 0 10rpx 30rpx rgba(23, 50, 77, 0.24);
  font-size: 27rpx;
  font-weight: 700;
}
```

- [x] **Step 5: 验证组件并提交**

```powershell
node miniprogram/tests/ai-copilot-component.test.js
node --check miniprogram/components/ai-copilot/index.js
node --check miniprogram/tests/ai-copilot-component.test.js
git diff --check -- miniprogram/components/ai-copilot miniprogram/tests/ai-copilot-component.test.js
git add miniprogram/components/ai-copilot/index.js miniprogram/components/ai-copilot/index.json miniprogram/components/ai-copilot/index.wxml miniprogram/components/ai-copilot/index.wxss miniprogram/tests/ai-copilot-component.test.js
git commit -m "feat(miniprogram): add floating AI copilot component"
```

Expected: `AI Copilot 组件测试全部通过`，精确提交五个组件/测试文件。

### Task 4: 支持 AI 页面安全预填且不自动发送

**Files:**

- Modify: `miniprogram/tests/ai-chat.test.js`
- Modify: `miniprogram/utils/ai-chat.js`
- Modify: `miniprogram/tests/ai-chat-page.test.js`
- Modify: `miniprogram/pages/ai-chat/index.js:7-17,49-71`
- Modify: `miniprogram/tests/ai-chat-view.test.js`
- Modify: `miniprogram/pages/ai-chat/index.wxml:100-111`

- [x] **Step 1: 写纯函数和页面失败测试**

在 `ai-chat.test.js` 的导入中加入 `normalizeInitialPrompt`，并加入：

```js
assert.equal(normalizeInitialPrompt(undefined), '')
assert.equal(normalizeInitialPrompt('请介绍首页'), '请介绍首页')
assert.equal(normalizeInitialPrompt('%E8%AF%B7%E4%BB%8B%E7%BB%8D%E9%A6%96%E9%A1%B5'), '请介绍首页')
assert.equal(normalizeInitialPrompt('%E0%A4%A'), '%E0%A4%A')
assert.equal(normalizeInitialPrompt('问'.repeat(4001)).length, 4000)
```

在 `ai-chat-page.test.js` 首次初始化后增加独立场景：

```js
  reset()
  const prefilledPage = createPage()
  prefilledPage.onLoad({
    scope: 'general',
    prompt: encodeURIComponent('请介绍患者首页应该怎样使用。')
  })
  assert.equal(prefilledPage.data.inputValue, '请介绍患者首页应该怎样使用。')
  assert.equal(prefilledPage.data.inputLength, 14)
  assert.equal(calls.requests.length, 0)

  reset()
  const freeQuestionPage = createPage()
  freeQuestionPage.onLoad({ scope: 'general' })
  assert.equal(freeQuestionPage.data.inputValue, '')
  assert.equal(freeQuestionPage.data.inputLength, 0)
  assert.equal(calls.requests.length, 0)
```

在 `ai-chat-view.test.js` 的 `requiredWxml` 加入：

```js
'可以询问健康问题或小程序使用方法'
```

- [x] **Step 2: 运行三项测试并确认 RED**

```powershell
node miniprogram/tests/ai-chat.test.js
node miniprogram/tests/ai-chat-page.test.js
node miniprogram/tests/ai-chat-view.test.js
```

Expected: 依次因 `normalizeInitialPrompt` 不存在、输入仍为空、旧 placeholder 缺少新文案而失败。

- [x] **Step 3: 实现纯预填清洗函数**

在 `utils/ai-chat.js` 中加入并导出：

```js
function normalizeInitialPrompt(value) {
  if (typeof value !== 'string') return ''
  let prompt = value
  try {
    prompt = decodeURIComponent(value)
  } catch (error) {
    prompt = value
  }
  return prompt.slice(0, MAX_MESSAGE_LENGTH)
}
```

并在 `module.exports` 中加入 `normalizeInitialPrompt`。

- [x] **Step 4: 页面只预填、不发送**

在 `pages/ai-chat/index.js` 导入 `normalizeInitialPrompt`，并在 `onLoad` 的 `setData` 前计算：

```js
    const inputValue = normalizeInitialPrompt(options.prompt)
```

将原来的空输入初始化替换为：

```js
      inputValue,
      inputLength: inputValue.length,
```

`onLoad` 中不得调用 `handleSend()`、`_sendMessage()` 或 `request()`。

将 WXML placeholder 改为：

```xml
placeholder="可以询问健康问题或小程序使用方法"
```

- [x] **Step 5: 验证回归并提交**

```powershell
node miniprogram/tests/ai-chat.test.js
node miniprogram/tests/ai-chat-page.test.js
node miniprogram/tests/ai-chat-view.test.js
node --check miniprogram/utils/ai-chat.js
node --check miniprogram/pages/ai-chat/index.js
git diff --check -- miniprogram/utils/ai-chat.js miniprogram/pages/ai-chat/index.js miniprogram/pages/ai-chat/index.wxml miniprogram/tests/ai-chat.test.js miniprogram/tests/ai-chat-page.test.js miniprogram/tests/ai-chat-view.test.js
git add miniprogram/utils/ai-chat.js miniprogram/pages/ai-chat/index.js miniprogram/pages/ai-chat/index.wxml miniprogram/tests/ai-chat.test.js miniprogram/tests/ai-chat-page.test.js miniprogram/tests/ai-chat-view.test.js
git commit -m "feat(miniprogram): prefill AI copilot questions"
```

Expected: 三项 AI 测试全部通过；页面加载仍没有请求，只有用户手动发送才访问 `/ai/chat`。

### Task 5: 将 Copilot 精确接入 11 个业务页面

**Files:**

- Create: `miniprogram/tests/ai-copilot-wiring.test.js`
- Modify: `miniprogram/pages/home/index.json`, `miniprogram/pages/home/index.wxml`
- Modify: `miniprogram/pages/scale/index.json`, `miniprogram/pages/scale/index.wxml`
- Modify: `miniprogram/pages/cognitive-center/index.json`, `miniprogram/pages/cognitive-center/index.wxml`
- Modify: `miniprogram/pages/cognitive/index.json`, `miniprogram/pages/cognitive/index.wxml`
- Modify: `miniprogram/pages/stroop/index.json`, `miniprogram/pages/stroop/index.wxml`
- Modify: `miniprogram/pages/tracking/index.json`, `miniprogram/pages/tracking/index.wxml`
- Modify: `miniprogram/pages/tracking-trend/index.json`, `miniprogram/pages/tracking-trend/index.wxml`
- Modify: `miniprogram/pages/report/index.json`, `miniprogram/pages/report/index.wxml`
- Modify: `miniprogram/pages/care-pathway/index.json`, `miniprogram/pages/care-pathway/index.wxml`
- Modify: `miniprogram/pages/education/index.json`, `miniprogram/pages/education/index.wxml`
- Modify: `miniprogram/pages/education-detail/index.json`, `miniprogram/pages/education-detail/index.wxml`

- [x] **Step 1: 写页面接线失败测试**

创建：

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pageKeys = [
  'home',
  'scale',
  'cognitive-center',
  'cognitive',
  'stroop',
  'tracking',
  'tracking-trend',
  'report',
  'care-pathway',
  'education',
  'education-detail'
]
const excludedPages = [
  'login',
  'register',
  'server-settings',
  'privacy-settings',
  'ai-chat'
]
const pagesRoot = path.join(__dirname, '..', 'pages')

for (const pageKey of pageKeys) {
  const directory = path.join(pagesRoot, pageKey)
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'))
  const wxml = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
  assert.equal(
    config.usingComponents && config.usingComponents['ai-copilot'],
    '/components/ai-copilot/index',
    `${pageKey} 未声明 ai-copilot`
  )
  assert.equal(
    wxml.includes(`<ai-copilot page-key="${pageKey}" />`),
    true,
    `${pageKey} 未渲染 ai-copilot`
  )
}

for (const pageKey of excludedPages) {
  const directory = path.join(pagesRoot, pageKey)
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'))
  const wxml = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
  assert.notEqual(
    config.usingComponents && config.usingComponents['ai-copilot'],
    '/components/ai-copilot/index'
  )
  assert.equal(wxml.includes('<ai-copilot'), false)
}

console.log('AI Copilot 页面接线测试全部通过')
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `node miniprogram/tests/ai-copilot-wiring.test.js`

Expected: FAIL，首个失败为 `home 未声明 ai-copilot`。

- [x] **Step 3: 在 11 个 JSON 中声明组件**

保留每个页面原有 `navigationBarTitleText` 和 `navigationStyle`，新增或合并以下字段：

```json
"usingComponents": {
  "ai-copilot": "/components/ai-copilot/index"
}
```

例如 `scale/index.json` 的完整结果应为：

```json
{
  "navigationBarTitleText": "ASRS 成人量表",
  "usingComponents": {
    "ai-copilot": "/components/ai-copilot/index"
  }
}
```

`home/index.json` 的完整结果应为：

```json
{
  "usingComponents": {
    "ai-copilot": "/components/ai-copilot/index"
  }
}
```

- [x] **Step 4: 在 11 个 WXML 中渲染唯一页面键**

分别在各页面最外层内容结尾加入以下精确实例：

```xml
<ai-copilot page-key="home" />
<ai-copilot page-key="scale" />
<ai-copilot page-key="cognitive-center" />
<ai-copilot page-key="cognitive" />
<ai-copilot page-key="stroop" />
<ai-copilot page-key="tracking" />
<ai-copilot page-key="tracking-trend" />
<ai-copilot page-key="report" />
<ai-copilot page-key="care-pathway" />
<ai-copilot page-key="education" />
<ai-copilot page-key="education-detail" />
```

每个页面只加入与自身页面键对应的一行；不得把 11 行同时放进同一页面。

- [x] **Step 5: 验证接线、JSON 和既有页面结构**

```powershell
node miniprogram/tests/ai-copilot-wiring.test.js
$viewTests = @(
  'home-view.test.js',
  'scale-view.test.js',
  'cognitive-center-view.test.js',
  'cognitive-view.test.js',
  'stroop-view.test.js',
  'tracking-view.test.js',
  'tracking-trend-page.test.js',
  'report-view.test.js',
  'care-pathway-view.test.js',
  'education-views.test.js'
)
foreach ($test in $viewTests) {
  node (Join-Path 'miniprogram/tests' $test)
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Get-ChildItem -LiteralPath miniprogram -Recurse -Filter '*.json' -File | ForEach-Object {
  Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json | Out-Null
}
```

Expected: 页面接线和全部既有视图测试通过，JSON 解析无错误。

- [x] **Step 6: 精确提交接线**

```powershell
git add miniprogram/tests/ai-copilot-wiring.test.js
git add miniprogram/pages/home/index.json miniprogram/pages/home/index.wxml
git add miniprogram/pages/scale/index.json miniprogram/pages/scale/index.wxml
git add miniprogram/pages/cognitive-center/index.json miniprogram/pages/cognitive-center/index.wxml
git add miniprogram/pages/cognitive/index.json miniprogram/pages/cognitive/index.wxml
git add miniprogram/pages/stroop/index.json miniprogram/pages/stroop/index.wxml
git add miniprogram/pages/tracking/index.json miniprogram/pages/tracking/index.wxml
git add miniprogram/pages/tracking-trend/index.json miniprogram/pages/tracking-trend/index.wxml
git add miniprogram/pages/report/index.json miniprogram/pages/report/index.wxml
git add miniprogram/pages/care-pathway/index.json miniprogram/pages/care-pathway/index.wxml
git add miniprogram/pages/education/index.json miniprogram/pages/education/index.wxml
git add miniprogram/pages/education-detail/index.json miniprogram/pages/education-detail/index.wxml
git diff --cached --name-only
git commit -m "feat(miniprogram): show AI copilot on patient pages"
```

Expected: 缓存区仅含 23 个本任务文件，无 `backend/`、登录、注册、设置或用户校验文件。

### Task 6: 全量验证、工作记录和实施状态

**Files:**

- Modify: `项目任务与进度.md`
- Modify: `docs/superpowers/plans/2026-08-24-miniprogram-ai-copilot.md`

- [x] **Step 1: 运行全部 56 个测试文件**

```powershell
$tests = @(Get-ChildItem -LiteralPath 'miniprogram/tests' -Filter '*.test.js' -File | Sort-Object Name)
foreach ($test in $tests) {
  node $test.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Output "全部自动测试通过，共 $($tests.Count) 个测试文件"
```

Expected: `全部自动测试通过，共 56 个测试文件`。

- [x] **Step 2: 运行 JavaScript、JSON、运行时和差异检查**

```powershell
$jsFiles = @(Get-ChildItem -LiteralPath 'miniprogram' -Recurse -Filter '*.js' -File)
foreach ($file in $jsFiles) {
  node --check $file.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Output "JavaScript 语法检查全部通过，共 $($jsFiles.Count) 个文件"

$jsonFiles = @(Get-ChildItem -LiteralPath 'miniprogram' -Recurse -Filter '*.json' -File)
foreach ($file in $jsonFiles) {
  Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json | Out-Null
}
Write-Output "JSON 解析检查全部通过，共 $($jsonFiles.Count) 个文件"

node miniprogram/tests/runtime-compatibility.test.js
git diff --check
git status --short
```

Expected: 98 个 JavaScript 文件和 22 个受 Git 管理的 JSON 文件通过；运行时兼容测试通过；差异检查无错误；状态中只含本计划和进度记录的待提交变化。主工作区可能额外包含微信开发者工具的私有 JSON，该文件不纳入 Git 交付统计。

- [x] **Step 3: 审计范围与敏感信息**

```powershell
git diff --name-only HEAD~4..HEAD
rg -n "QWEN_API_KEY|DASHSCOPE_API_KEY|(^|[^A-Za-z0-9])sk-[A-Za-z0-9]{16,}" miniprogram
```

Expected: 差异只涉及本计划列出的 `miniprogram/`、计划和进度文件；密钥扫描无输出；无 `backend/`、医生 Web、PPT 或部署文件。

- [x] **Step 4: 更新项目进度和工作日志**

在 `项目任务与进度.md` 的当前结论中保持 D13 为 75%、D14 不提前记为完成，并在工作日志追加：

```markdown
| 2026-08-24 | Codex | 按 TDD 完成儿童量表题数提示修正和患者业务页浮动 AI Copilot | SNAP-IV 未完成提示按实际配置显示 26 题，ASRS 保持 18 题；11 个业务页面接入本地静态 Copilot 卡片；“如何使用本页”只预填不自动发送，“自己提问”保持空白输入；继续复用 `/ai/chat`，未修改后端或写入外部 AI 密钥；56 个测试文件、98 个 JavaScript 文件、22 个受 Git 管理 JSON 文件及 Git 差异检查通过 | 在微信开发者工具中人工确认 11 页浮动位置、卡片交互、预填无自动请求和 SNAP-IV 26 题提示；外部 AI 密钥与正式部署仍由 B 负责 |
```

在“阻塞与决策”追加：

```markdown
| 2026-08-24 | 页面级 AI Copilot | 采用精简 A-only 方案：本地静态页面建议 + 跳转现有 AI 助手；小程序不直连外部 AI，不修改 B 后端；预填问题必须由用户手动发送 |
```

- [x] **Step 5: 勾选本计划已完成步骤并提交记录**

先把本计划实际完成的 `- [ ]` 改为 `- [x]`，不得勾选未执行的微信开发者工具人工验收。然后：

```powershell
git add '项目任务与进度.md' 'docs/superpowers/plans/2026-08-24-miniprogram-ai-copilot.md'
git diff --cached --name-only
git commit -m "docs: record miniprogram AI copilot delivery"
```

Expected: 只提交进度总表和本计划。

- [x] **Step 6: 请求代码审查并处理结论**

使用 `superpowers:requesting-code-review` 审查：设计覆盖、11 页接线、未自动发送、导航失败、动态题数、A/B 边界、旧微信兼容和用户文件保护。任何修正先运行对应失败测试，再提交独立修复。

执行结果：独立审查无 Critical；两个 Important 分别为 WXSS 旧内核回退和异步导航防重。另修正带 `%20/%25` 的普通文本二次解码边界，并收窄兼容性记录措辞。所有修正均先观察失败测试，再通过 56 项全量回归；提交 `1dab22c`。

- [ ] **Step 7: 完成分支前验证并集成**

使用 `superpowers:verification-before-completion` 重新运行 Task 6 Step 1—3；全部通过后使用 `superpowers:finishing-a-development-branch` 合并到 `main`。合并后在主工作区执行：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'miniprogram/utils/register-validation.js'
git status --short
git log -8 --oneline
```

Expected: 用户文件 SHA-256 仍为 `E57487BEE100A4C52F593C280CD16CF9E5D776BE6C173933D2232C1AE699F094`；`git status --short` 仍只显示该用户文件的原有 `M`，不会出现未提交的 Copilot 文件。

## 人工验收清单（不提前记为自动完成）

1. 微信开发者工具点击“编译”，问题数量保持 0。
2. 依次打开 11 个业务页面，右下角均出现 AI 按钮，登录、注册、服务器设置、隐私设置和 AI 页不出现。
3. 展开提示卡，确认不遮挡页面主要按钮和 iPhone 底部安全区；关闭和再次打开正常。
4. 点击“如何使用本页”，AI 页显示当前页面问题；Network 面板在用户点击发送前没有 `/ai/chat` 请求。
5. 点击“自己提问”，AI 页输入框为空，placeholder 为“可以询问健康问题或小程序使用方法”。
6. 后端在线时手动发送一次，确认仍由现有 `/api/v1/ai/chat` 返回；后端离线时卡片可展开，发送后显示现有网络错误。
7. 使用儿童患者进入 SNAP-IV，在未完成状态触发提交，确认提示 26 题；成人 ASRS 同场景提示 18 题。
