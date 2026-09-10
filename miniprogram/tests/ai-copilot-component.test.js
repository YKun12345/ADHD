const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const calls = {
  navigation: [],
  toasts: [],
  storageWrites: []
}
const nativeSetTimeout = global.setTimeout
global.setTimeout = (callback, delay) => {
  if (delay === 300) callback()
  return { unref() {} }
}
let componentDefinition
let navigationShouldFail = false
let navigationShouldWait = false
let pendingNavigation
let savedPosition

global.wx = {
  getStorageSync(key) {
    if (key === 'current_user') return { id: 7, role: 'patient' }
    if (key === 'ai_copilot_position_v1:patient:7') return savedPosition
    return undefined
  },
  setStorageSync(key, value) {
    savedPosition = value
    calls.storageWrites.push({ key, value })
  },
  getWindowInfo() {
    return {
      windowWidth: 375,
      windowHeight: 812,
      statusBarHeight: 44,
      safeArea: { top: 44, bottom: 778 }
    }
  },
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
assert.equal(component.data.guideBubbleVisible, true)
assert.equal(component.data.config.intro.length > 0, true)
assert.equal(component.data.positionX, 311)
assert.equal(component.data.positionY, 710)
assert.equal(component.data.dockSide, 'right')

component.closeGuideBubble()
assert.equal(component.data.guideBubbleVisible, false)

component.togglePanel()
assert.equal(component.data.expanded, true)
component.closePanel()
assert.equal(component.data.expanded, false)

component.handleDragStart({ touches: [{ clientX: 330, clientY: 730 }] })
component.handleDragMove({ touches: [{ clientX: 100, clientY: 350 }] })
assert.equal(component.data.positionX, 81)
assert.equal(component.data.positionY, 330)
component.handleDragEnd()
assert.equal(component.data.positionX, 12)
assert.equal(component.data.positionY, 330)
assert.equal(component.data.dockSide, 'left')
assert.deepEqual(calls.storageWrites.at(-1), {
  key: 'ai_copilot_position_v1:patient:7',
  value: { version: 1, side: 'left', yRatio: 0.3811 }
})
component.togglePanel()
assert.equal(component.data.expanded, false, '拖动结束后的合成点击不得打开面板')
component.togglePanel()
assert.equal(component.data.expanded, true)
component.closePanel()

componentDefinition.pageLifetimes.resize.call(component, {
  size: {
    windowWidth: 768,
    windowHeight: 1024,
    statusBarHeight: 24,
    safeArea: { top: 24, bottom: 1000 }
  }
})
assert.equal(component.data.positionX, 12)
assert.equal(component.data.positionY, 402)

component.handleDragStart({ touches: [{ clientX: 20, clientY: 410 }] })
component.handleDragMove({ touches: [{ clientX: 23, clientY: 413 }] })
component.handleDragEnd()
assert.equal(component.data.positionX, 12, '轻微手抖应恢复拖动前位置')
assert.equal(component.data.positionY, 402, '轻微手抖应恢复拖动前位置')
component.togglePanel()
assert.equal(component.data.expanded, true, '轻触仍应正常打开面板')
component.closePanel()

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
  'wx:if="{{!expanded}}"',
  'catchtouchstart="handleDragStart"',
  'catchtouchmove="handleDragMove"',
  'catchtouchend="handleDragEnd"',
  'left: {{positionX}}px',
  'top: {{positionY}}px',
  'ai-copilot--{{dockSide}}',
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
assert.match(copilotRule[1], /width:\s*104rpx/)
assert.match(copilotRule[1], /height:\s*104rpx/)
assert.doesNotMatch(copilotRule[1], /right:|bottom:/)

const panelRule = wxss.match(/\.ai-copilot__panel\s*\{([^}]*)\}/)
assert.ok(panelRule, 'WXSS 缺少 .ai-copilot__panel 样式规则')
assert.match(panelRule[1], /position:\s*fixed/)
assert.match(panelRule[1], /constant\(safe-area-inset-bottom\)/)
assert.match(panelRule[1], /env\(safe-area-inset-bottom\)/)

const actionFallbackRule = wxss.match(
  /\.ai-copilot__action\s*\+\s*\.ai-copilot__action\s*\{([^}]*)\}/
)
assert.ok(actionFallbackRule, 'WXSS 缺少按钮间距回退规则')
assert.match(actionFallbackRule[1], /margin-left:\s*12rpx/)

console.log('AI Copilot 组件测试全部通过')
global.setTimeout = nativeSetTimeout
