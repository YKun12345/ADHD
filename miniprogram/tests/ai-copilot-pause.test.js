const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const test = require('node:test')
const vm = require('node:vm')
const { createHarness } = require('./helpers/cognitive-harness')

const sourcePath = path.join(__dirname, '..', 'components', 'ai-copilot', 'index.js')
const markup = fs.readFileSync(path.join(path.dirname(sourcePath), 'index.wxml'), 'utf8')

function createCopilot(properties = {}) {
  const timers = new Map()
  const callbacks = []
  const updates = []
  const navigation = []
  const storage = { current_user: { id: 7, role: 'patient' } }
  global.wx = {
    getStorageSync(key) { return storage[key] },
    setStorageSync(key, value) { storage[key] = value },
    getWindowInfo() { return { windowWidth: 375, windowHeight: 812 } },
    navigateTo(options) { navigation.push(options.url) },
    showToast() {}
  }
  let definition
  let timerId = 0
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    require: createRequire(sourcePath),
    wx: global.wx,
    Component(value) { definition = value },
    setTimeout(callback, delay) {
      const id = ++timerId
      callbacks.push(callback)
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) }
  })
  const defaults = Object.fromEntries(Object.entries(definition.properties).map(([name, property]) => [name, property.value]))
  const view = {
    ...definition.methods,
    data: { ...defaults, ...definition.data, pageKey: 'cognitive', ...properties },
    setData(patch) { updates.push(patch); Object.assign(this.data, patch) }
  }
  return {
    definition, view, timers, callbacks, updates, navigation,
    attach() { definition.lifetimes.attached.call(view) },
    setPaused(value) {
      assert.equal(typeof definition.observers?.paused, 'function', '暂停状态需要同步清理反馈')
      view.data.paused = value
      definition.observers.paused.call(view, value)
    },
    hide() {
      assert.equal(typeof definition.pageLifetimes?.hide, 'function', '隐藏时需要清理介绍计时')
      definition.pageLifetimes.hide.call(view)
    },
    show() { definition.pageLifetimes.show.call(view) },
    detach() { definition.lifetimes.detached.call(view) },
    runNextTimer() {
      const [id, timer] = [...timers][0]
      timers.delete(id)
      timer.callback()
    }
  }
}

function evaluateBinding(template, data) {
  assert.match(template, /^\{\{[\s\S]*\}\}$/)
  return vm.runInNewContext(template.slice(2, -2), { ...data })
}

test('copilot pause defaults off and controls both internal mascot instances', () => {
  const h = createCopilot()
  assert.equal(h.definition.properties.paused?.type?.name, 'Boolean')
  assert.equal(h.definition.properties.paused.value, false)
  const avatars = [...markup.matchAll(/<ai-mascot\b([^>]*?)\/>/g)]
  assert.equal(avatars.length, 2)
  for (const [, attributes] of avatars) {
    const binding = attributes.match(/\bactive="([^"]+)"/)
    assert.ok(binding, '浮动头像和面板装饰头像均需连接 active')
    assert.equal(evaluateBinding(binding[1], { paused: false }), true)
    assert.equal(evaluateBinding(binding[1], { paused: true }), false)
  }
})

test('pausing cancels a pending intro; resuming allows one touch opening without navigation', () => {
  const h = createCopilot()
  h.attach()
  assert.equal(h.timers.size, 1)
  const staleShow = h.callbacks[0]
  h.setPaused(true)
  assert.equal(h.timers.size, 0)
  const updateCount = h.updates.length
  staleShow()
  assert.equal(h.updates.length, updateCount)
  h.view.handleDragStart({ touches: [{ clientX: 320, clientY: 700 }] })
  h.view.handleDragEnd()
  h.view.togglePanel()
  assert.equal(h.view.data.expanded, false)
  h.setPaused(false)
  assert.equal(h.timers.size, 0, '恢复后不补播已取消的介绍')
  h.view.handleDragStart({ touches: [{ clientX: 320, clientY: 700 }] })
  h.view.handleDragEnd()
  assert.equal(h.view.data.expanded, true)
  assert.equal(h.navigation.length, 0)
  assert.doesNotMatch(markup, /bindinteract="(?:togglePanel|handleDragEnd)"/, '不能再由子组件重复切换面板')
  h.detach()
})

test('pausing an open copilot clears its guide and help and blocks navigation', () => {
  const h = createCopilot()
  h.attach()
  h.runNextTimer()
  assert.equal(h.view.data.guideBubbleVisible, true)
  h.view.openPageHelp()
  assert.equal(h.view.data.inlineHelpVisible, true)
  h.setPaused(true)
  assert.equal(h.view.data.expanded, false)
  assert.equal(h.view.data.inlineHelpVisible, false)
  assert.equal(h.view.data.guideBubbleVisible, false)
  assert.equal(h.timers.size, 0)
  h.view.openFreeQuestion()
  h.view.openPageHelp()
  assert.equal(h.view.data.expanded, false)
  assert.equal(h.navigation.length, 0)
  h.detach()
})

test('initially paused copilots schedule no intro and can resume safely', () => {
  const h = createCopilot({ paused: true })
  h.attach()
  assert.equal(h.timers.size, 0)
  assert.equal(h.view.data.guideBubbleVisible, false)
  h.setPaused(false)
  h.view.togglePanel()
  assert.equal(h.view.data.expanded, true)
  h.detach()
})

test('page hide and destruction cancel all intro callbacks without replaying them', () => {
  const h = createCopilot()
  h.attach()
  const staleShow = h.callbacks[0]
  h.hide()
  assert.equal(h.timers.size, 0)
  const updateCount = h.updates.length
  staleShow()
  assert.equal(h.updates.length, updateCount)
  h.view.togglePanel()
  assert.equal(h.view.data.expanded, false)
  h.show()
  assert.equal(h.view.data.guideBubbleVisible, false)
  assert.equal(h.timers.size, 0)
  h.view.togglePanel()
  assert.equal(h.view.data.expanded, true)
  h.detach()
  const detachedUpdateCount = h.updates.length
  staleShow()
  assert.equal(h.updates.length, detachedUpdateCount)
})

test('all six actual task controllers drive pause with their execution state and hide the copilot during answers', () => {
  const h = createHarness()
  try {
    for (const name of ['cognitive', 'stroop', 'flanker', 'nback', 'trail', 'digit-span']) {
      const wxml = fs.readFileSync(path.join(__dirname, '..', 'pages', name, 'index.wxml'), 'utf8')
      const tag = wxml.match(/<ai-copilot\b[^>]*\/>/)[0]
      const paused = tag.match(/\bpaused="([^"]+)"/)
      assert.ok(paused, `${name} 必须连接真实暂停状态`)
      const visible = tag.match(/\bwx:if="([^"]+)"/)[1]
      const page = h.load(name)
      assert.equal(evaluateBinding(paused[1], page.data), false)
      h.start(page)
      assert.equal(page.data.running, true)
      assert.equal(evaluateBinding(paused[1], page.data), true, `${name} 作答期间暂停动作`)
      assert.equal(evaluateBinding(visible, page.data), false, `${name} 作答期间不显示助手`)
      if (name === 'trail') {
        const transition = { ...page.data, running: false, phase: 'transition' }
        assert.equal(evaluateBinding(paused[1], transition), true, '连线阶段间仍保持暂停')
        assert.equal(evaluateBinding(visible, transition), false)
      }
      page.onHide()
      assert.equal(page.data.running, false)
      assert.equal(evaluateBinding(paused[1], page.data), false)
      page.onUnload()
    }
  } finally { h.restore() }
})

test('an actual completed task restores copilot availability on its result page', async () => {
  const h = createHarness()
  try {
    const page = h.load('flanker')
    const wxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'flanker', 'index.wxml'), 'utf8')
    const tag = wxml.match(/<ai-copilot\b[^>]*\/>/)[0]
    const paused = tag.match(/\bpaused="([^"]+)"/)
    assert.ok(paused, '结果页需要真实暂停绑定')
    const visible = tag.match(/\bwx:if="([^"]+)"/)[1]
    h.start(page)
    for (let index = 0; index < 24; index++) {
      page.handleAnswer({ currentTarget: { dataset: { direction: page._trials[index].target, trial: index + 1 } } })
      if (index < 23) h.advance(250)
    }
    await h.flush()
    assert.equal(page.data.phase, 'result')
    assert.equal(page.data.running, false)
    assert.equal(evaluateBinding(paused[1], page.data), false)
    assert.equal(evaluateBinding(visible, page.data), true)
    page.onUnload()
  } finally { h.restore() }
})
