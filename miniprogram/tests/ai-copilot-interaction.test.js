const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const test = require('node:test')

const root = path.join(__dirname, '..')
const markup = fs.readFileSync(path.join(root, 'components/ai-copilot/index.wxml'), 'utf8')

function createPair(properties = {}) {
  const timers = new Map(), history = [], rendered = [], updates = [], requests = []
  const storage = { current_user: { id: 7, role: 'researcher' } }
  let nextId = 0, running = false
  const clock = {
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); history.push(callback); return id },
    clearTimeout(id) { timers.delete(id) }
  }
  const wx = {
    getStorageSync(key) { return storage[key] },
    setStorageSync(key, value) { storage[key] = value },
    getWindowInfo() { return { windowWidth: 375, windowHeight: 812, safeArea: { bottom: 778 } } },
    navigateTo(options) { requests.push(options) },
    showToast() {}
  }
  global.wx = wx
  function load(name) {
    const filename = path.join(root, 'components', name, 'index.js')
    let definition
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      ...clock, wx, require: createRequire(filename),
      getCurrentPages: () => [{ data: { running } }],
      Component(value) { definition = value }
    })
    return definition
  }
  function defaults(definition) {
    return { ...Object.fromEntries(Object.entries(definition.properties).map(([key, value]) => [key, value.value])), ...definition.data }
  }
  const petDefinition = load('ai-mascot')
  const definition = load('ai-copilot')
  const pet = {
    ...petDefinition.methods,
    data: { ...defaults(petDefinition), touchManaged: false },
    setData(patch) { Object.assign(this.data, patch) },
    triggerEvent(name, detail) { if (name === 'interact') view.handlePetInteract({ detail }) }
  }
  const view = {
    ...definition.methods,
    data: { ...defaults(definition), pageKey: 'doctor-home', ...properties },
    setData(patch, callback) {
      updates.push(patch)
      Object.assign(this.data, patch)
      if ('reducedMotion' in patch) {
        pet.data.reducedMotion = this.data.reducedMotion
        petDefinition.observers['state, active, reducedMotion, decorative'].call(pet)
      }
      if (callback) rendered.push(callback)
    },
    selectComponent(selector) {
      assert.equal(selector, '#copilot-panel-mascot')
      return this.data.expanded ? pet : null
    }
  }
  petDefinition.lifetimes.attached.call(pet)
  return {
    view, pet, definition, timers, history, updates, requests, storage,
    attach() { definition.lifetimes.attached.call(view) },
    render() { while (rendered.length) rendered.shift()() },
    touch() { view.handleDragStart({ touches: [{ clientX: 320, clientY: 700 }] }); view.handleDragEnd() },
    hide() { definition.pageLifetimes.hide.call(view); petDefinition.pageLifetimes.hide.call(pet) },
    detach() { definition.lifetimes.detached.call(view); petDefinition.lifetimes.detached.call(pet) },
    pause() { view.data.paused = true; definition.observers.paused.call(view, true); pet.data.active = false; petDefinition.observers['state, active, reducedMotion, decorative'].call(pet) },
    setRunning(value) { running = value },
    runTimer() { const [id, timer] = [...timers][0]; timers.delete(id); timer.callback() }
  }
}

test('a verified touch opens existing help with a real pet reaction and a short reply', () => {
  const h = createPair()
  h.attach()
  h.touch()
  assert.equal(h.view.data.expanded, true)
  assert.equal(h.pet.data.reaction, '')
  h.render()
  assert.equal(h.pet.data.reaction, 'blink')
  assert.match(h.view.data.petFeedback, /眨.*眼/)
  assert.equal(h.timers.size, 1, '只保留宠物当前动作的计时')
  h.pet.onInteract()
  assert.equal(h.pet.data.reaction, 'tilt')
  assert.match(h.view.data.petFeedback, /在听/)
  h.pet.onInteract()
  assert.equal(h.pet.data.reaction, 'wave')
  assert.match(h.view.data.petFeedback, /挥.*手/)
  h.view.openPageHelp()
  assert.equal(h.view.data.inlineHelpVisible, true)
  assert.ok(h.view.data.helpSteps.length)
  assert.equal(h.requests.length, 0)
  h.detach()
})

test('dragging and cancelled touches never greet, animate or open help', () => {
  const h = createPair()
  h.attach()
  h.view.handleDragStart({ touches: [{ clientX: 320, clientY: 700 }] })
  h.view.handleDragMove({ touches: [{ clientX: 100, clientY: 400 }] })
  h.view.handleDragEnd()
  h.render()
  assert.equal(h.view.data.expanded, false)
  assert.equal(h.view.data.petFeedback, '')
  assert.equal(h.pet.data.reaction, '')
  assert.equal(h.timers.size, 0)
  const saved = h.storage['ai_copilot_position_v1:researcher:7']
  assert.equal(saved.side, 'left')
  h.view.handleDragStart({ touches: [{ clientX: 30, clientY: 400 }] })
  h.view.handleDragCancel()
  h.view.handleDragEnd()
  h.render()
  assert.equal(h.view.data.expanded, false)
  assert.equal(h.storage['ai_copilot_position_v1:researcher:7'], saved)
  h.touch()
  h.render()
  assert.equal(h.pet.data.reaction, 'blink', '拖动后的第一次真实轻触立即回应')
  h.detach()
})

test('new authorization and login surfaces keep assistance on the current form without navigating', () => {
  const h=createPair({localHelpOnly:true})
  h.attach();h.touch();h.render()
  assert.equal(h.view.data.expanded,true)
  assert.equal(h.view.navigateToAi('/pages/agent-chat/index?scope=general'),false)
  assert.equal(h.view.data.inlineHelpVisible,true)
  assert.equal(h.requests.length,0)
  assert.match(markup,/wx:if="\{\{!localHelpOnly\}\}"[\s\S]*?ai-copilot__action--secondary/)
  h.detach()
})

test('stale render callbacks and intro timers cannot greet after pause, hide, close or destruction', () => {
  for (const stop of ['pause', 'hide', 'detach', 'close']) {
    const h = createPair()
    h.attach()
    const oldIntro = h.history[0]
    h.touch()
    if (stop === 'close') h.view.closePanel()
    else h[stop]()
    const count = h.updates.length
    h.render()
    oldIntro()
    assert.equal(h.updates.length, count, stop)
    assert.equal(h.pet.data.reaction, '', stop)
    assert.equal(h.timers.size, 0, stop)
  }
})

test('reduced motion is available from the copilot and cancels intro timers', () => {
  const h = createPair()
  h.attach()
  assert.equal(typeof h.view.toggleReducedMotion, 'function')
  h.view.toggleReducedMotion()
  assert.equal(h.view.data.reducedMotion, true)
  assert.equal(h.timers.size, 0)
  h.touch()
  h.render()
  assert.equal(h.pet.data.motionActive, false)
  assert.equal(h.pet.data.reaction, 'blink')
  assert.equal(h.timers.size, 0)
  h.detach()
  const quiet = createPair({ reducedMotion: true })
  quiet.attach()
  assert.equal(quiet.timers.size, 0)
  quiet.detach()
})

test('busy navigation and actual timed answers do not accept pet touches', () => {
  const h = createPair()
  h.attach()
  h.view.openFreeQuestion()
  assert.equal(h.requests.length, 1)
  h.touch()
  h.render()
  assert.equal(h.view.data.expanded, false)
  assert.equal(h.pet.data.reaction, '')
  h.hide()
  const count = h.updates.length
  h.requests[0].success()
  h.requests[0].complete()
  assert.equal(h.updates.length, count, '页面退出后导航回调不得写回')
  h.detach()
  const task = createPair()
  task.attach()
  task.setRunning(true)
  task.touch()
  task.view.openPageHelp()
  task.render()
  assert.equal(task.view.data.expanded, false)
  assert.equal(task.pet.data.reaction, '')
  task.detach()
})

test('destruction also rejects stale resize, show and pet feedback events', () => {
  const h = createPair()
  h.attach()
  h.detach()
  const count = h.updates.length
  h.definition.pageLifetimes.resize.call(h.view, { size: { windowWidth: 768, windowHeight: 1024 } })
  h.definition.pageLifetimes.show.call(h.view)
  h.view.handlePetInteract({ detail: { state: 'idle', accepted: true, reaction: 'wave' } })
  assert.equal(h.updates.length, count)
  assert.equal(h.timers.size, 0)
})

test('tab clearance keeps the default in the lower right and restores a saved doctor position', () => {
  const h = createPair({ bottomInset: 60 })
  h.attach()
  assert.equal(h.view.data.positionX, 311)
  assert.equal(h.view.data.positionY, 650)
  h.detach()
  const remembered = createPair({ bottomInset: 60 })
  const saved = { version: 1, side: 'left', yRatio: 0.5 }
  remembered.storage['ai_copilot_position_v1:researcher:7'] = saved
  remembered.attach()
  assert.equal(remembered.view.data.dockSide, 'left')
  assert.equal(remembered.view.data.positionY, 351)
  assert.equal(remembered.storage['ai_copilot_position_v1:researcher:7'], saved)
  remembered.detach()
})

test('template exposes greeting, motion preference and separate managed floating and interactive panel pets', () => {
  const pets = [...markup.matchAll(/<ai-mascot\b([^>]*?)\/>/g)].map(([, attrs]) => attrs)
  assert.equal(pets.length, 2)
  assert.ok(pets.every(attrs => /reduced-motion="\{\{reducedMotion\}\}"/.test(attrs)))
  assert.ok(pets.some(attrs => /touch-managed="\{\{true\}\}"/.test(attrs)))
  assert.ok(pets.some(attrs => /id="copilot-panel-mascot"/.test(attrs) && /bind:interact="handlePetInteract"/.test(attrs)))
  assert.match(markup, /你好，我是星仔/)
  assert.match(markup, /\{\{petFeedback\}\}/)
  assert.match(markup, /bindtap="toggleReducedMotion"/)
})
