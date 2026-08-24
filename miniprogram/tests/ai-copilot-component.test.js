const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const calls = {
  navigation: [],
  toasts: []
}
let componentDefinition
let navigationShouldFail = false
let navigationShouldWait = false
let pendingNavigation

global.wx = {
  navigateTo(options) {
    calls.navigation.push(options.url)
    if (navigationShouldWait) {
      pendingNavigation = options
      return
    }
    if (navigationShouldFail) options.fail()
    else options.success()
    if (options.complete) options.complete()
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
    data: {
      ...componentDefinition.data,
      pageKey
    },
    setData(patch) {
      this.data = {
        ...this.data,
        ...patch
      }
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
assert.equal(
  calls.navigation[1],
  '/pages/ai-chat/index?scope=general'
)

navigationShouldFail = true
component.togglePanel()
component.openFreeQuestion()
assert.equal(component.data.expanded, true)
assert.deepEqual(calls.toasts.at(-1), {
  title: '暂时无法打开AI助手',
  icon: 'none'
})

navigationShouldFail = false
navigationShouldWait = true
const guardedComponent = createComponent('home')
componentDefinition.lifetimes.attached.call(guardedComponent)
const navigationCountBeforeGuard = calls.navigation.length
guardedComponent.openPageHelp()
guardedComponent.openFreeQuestion()
assert.equal(
  calls.navigation.length,
  navigationCountBeforeGuard + 1,
  '导航完成前的快速重复点击只能打开一次页面'
)
assert.equal(guardedComponent.data.navigating, true)
pendingNavigation.success()
pendingNavigation.complete()
assert.equal(guardedComponent.data.navigating, false)

const directory = path.join(
  __dirname,
  '..',
  'components',
  'ai-copilot'
)
const json = JSON.parse(
  fs.readFileSync(path.join(directory, 'index.json'), 'utf8')
)
const wxml = fs.readFileSync(
  path.join(directory, 'index.wxml'),
  'utf8'
)
const wxss = fs.readFileSync(
  path.join(directory, 'index.wxss'),
  'utf8'
)

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
]) {
  assert.equal(
    wxml.includes(fragment),
    true,
    `WXML 缺少：${fragment}`
  )
}

for (const fragment of [
  '.ai-copilot',
  'position: fixed',
  'env(safe-area-inset-bottom)',
  '.ai-copilot__panel',
  '.ai-copilot__trigger'
]) {
  assert.equal(
    wxss.includes(fragment),
    true,
    `WXSS 缺少：${fragment}`
  )
}

const copilotRule = wxss.match(/\.ai-copilot\s*\{([^}]*)\}/)
assert.ok(copilotRule, 'WXSS 缺少 .ai-copilot 样式规则')
const baseBottomIndex = copilotRule[1].indexOf('bottom: 32rpx')
const constantBottomIndex = copilotRule[1].indexOf(
  'bottom: calc(32rpx + constant(safe-area-inset-bottom))'
)
const envBottomIndex = copilotRule[1].indexOf(
  'bottom: calc(32rpx + env(safe-area-inset-bottom))'
)
assert.equal(baseBottomIndex >= 0, true, 'WXSS 缺少基础 bottom 回退')
assert.equal(
  constantBottomIndex > baseBottomIndex,
  true,
  'constant() 安全区回退顺序错误'
)
assert.equal(
  envBottomIndex > constantBottomIndex,
  true,
  'env() 安全区回退顺序错误'
)

const actionFallbackRule = wxss.match(
  /\.ai-copilot__action\s*\+\s*\.ai-copilot__action\s*\{([^}]*)\}/
)
assert.ok(actionFallbackRule, 'WXSS 缺少按钮间距回退规则')
assert.match(actionFallbackRule[1], /margin-left:\s*12rpx/)

console.log('AI Copilot 组件测试全部通过')
