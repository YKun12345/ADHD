const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const calls = {
  navigation: [],
  toasts: []
}
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

console.log('AI Copilot 组件测试全部通过')
