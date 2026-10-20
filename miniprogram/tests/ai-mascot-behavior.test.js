const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'ai-mascot', 'index.js'), 'utf8')

function createMascot(properties = {}) {
  let definition
  let nextTimerId = 0
  const timers = new Map()
  const history = []
  const events = []
  vm.runInNewContext(source, {
    Component(value) { definition = value },
    setTimeout(callback, delay) {
      const id = ++nextTimerId
      timers.set(id, { callback, delay })
      history.push({ id, callback, delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) }
  })
  const defaults = Object.fromEntries(Object.entries(definition.properties).map(([key, property]) => [key, property.value]))
  const updates = []
  const component = {
    data: { ...defaults, ...definition.data, ...properties },
    ...definition.methods,
    setData(patch) {
      updates.push(patch)
      Object.assign(this.data, patch)
    },
    triggerEvent(name, detail) { events.push({ name, detail }) }
  }
  return {
    definition, component, timers, history, events, updates,
    attach() {
      assert.equal(typeof definition.lifetimes?.attached, 'function', '组件需要 attached 生命周期管理动作')
      definition.lifetimes.attached.call(component)
    },
    hide() { definition.pageLifetimes.hide.call(component) },
    show() { definition.pageLifetimes.show.call(component) },
    detach() { definition.lifetimes.detached.call(component) },
    update(patch) {
      Object.assign(component.data, patch)
      definition.observers['state, active, reducedMotion, decorative'].call(component)
    },
    finishReaction() {
      const [id, timer] = [...timers][0]
      timers.delete(id)
      timer.callback()
    }
  }
}

test('motion controls default to active and full motion without changing the public state', () => {
  const harness = createMascot()
  assert.equal(harness.component.data.active, true)
  assert.equal(harness.component.data.reducedMotion, false)
  harness.attach()
  assert.equal(harness.component.data.motionActive, true)
  assert.equal(harness.component.data.state, 'idle')
  assert.equal(harness.timers.size, 0, '待机不需要 JavaScript 轮询计时')
})

test('idle taps rotate blink, tilt and wave and return to the controlled idle state', () => {
  const harness = createMascot()
  harness.attach()
  for (const reaction of ['blink', 'tilt', 'wave', 'blink']) {
    harness.component.onInteract()
    assert.equal(harness.component.data.reaction, reaction)
    assert.equal(harness.component.data.state, 'idle')
    assert.equal(harness.timers.size, 1)
    assert.equal(harness.events.at(-1).name, 'interact')
    assert.equal(harness.events.at(-1).detail.reaction, reaction)
    assert.equal(harness.events.at(-1).detail.accepted, true)
    assert.equal(harness.events.at(-1).detail.animated, true)
    harness.finishReaction()
    assert.equal(harness.component.data.reaction, '')
    assert.equal(harness.timers.size, 0)
  }
})

test('a parent-managed floating pet ignores native taps until the parent accepts the touch', () => {
  const harness = createMascot({ touchManaged: true })
  harness.attach()
  harness.component.onInteract({ type: 'tap' })
  assert.equal(harness.events.length, 0)
  assert.equal(harness.component.data.reaction, '')
  assert.equal(harness.timers.size, 0)
  harness.component.onInteract()
  assert.equal(harness.component.data.reaction, 'blink')
  assert.equal(harness.events.length, 1)
})

test('repeated taps keep one timer and a cleared callback cannot erase the newer reaction', () => {
  const harness = createMascot()
  harness.attach()
  harness.component.onInteract()
  const firstCallback = harness.history[0].callback
  harness.component.onInteract()
  assert.equal(harness.component.data.reaction, 'tilt')
  assert.equal(harness.timers.size, 1)
  firstCallback()
  assert.equal(harness.component.data.reaction, 'tilt')
  harness.finishReaction()
  assert.equal(harness.component.data.reaction, '')
})

test('every business state keeps priority over a tap', () => {
  for (const state of ['wave', 'happy', 'thinking', 'listening', 'guide', 'care', 'waiting', 'success', 'recover', 'sleep']) {
    const harness = createMascot({ state })
    harness.attach()
    harness.component.onInteract()
    assert.equal(harness.component.data.state, state)
    assert.equal(harness.component.data.reaction, '', `${state} 不得被轻触覆盖`)
    assert.equal(harness.timers.size, 0)
    assert.equal(harness.events.at(-1).detail.state, state)
    assert.equal(harness.events.at(-1).detail.accepted, false)
    assert.equal(harness.events.at(-1).detail.animated, false)
  }
})

test('a real business transition cancels the transient reaction and its stale callback', () => {
  const harness = createMascot()
  harness.attach()
  harness.component.onInteract()
  const callback = harness.history[0].callback
  harness.update({ state: 'thinking' })
  assert.equal(harness.component.data.reaction, '')
  assert.equal(harness.timers.size, 0)
  const updateCount = harness.updates.length
  callback()
  assert.equal(harness.updates.length, updateCount)
  assert.equal(harness.component.data.state, 'thinking')
})

test('page hide cancels all timers and taps; show restores motion without replaying reactions', () => {
  const harness = createMascot()
  harness.attach()
  harness.component.onInteract()
  const callback = harness.history[0].callback
  harness.hide()
  assert.equal(harness.component.data.motionActive, false)
  assert.equal(harness.component.data.reaction, '')
  assert.equal(harness.timers.size, 0)
  const eventCount = harness.events.length
  const updateCount = harness.updates.length
  harness.component.onInteract()
  callback()
  assert.equal(harness.events.length, eventCount)
  assert.equal(harness.updates.length, updateCount)
  harness.show()
  assert.equal(harness.component.data.motionActive, true)
  assert.equal(harness.component.data.reaction, '')
  assert.equal(harness.timers.size, 0)
})

test('active false cancels a reaction and remains paused across a page show', () => {
  const harness = createMascot()
  harness.attach()
  harness.component.onInteract()
  harness.update({ active: false })
  assert.equal(harness.component.data.motionActive, false)
  assert.equal(harness.component.data.reaction, '')
  assert.equal(harness.timers.size, 0)
  harness.hide()
  harness.show()
  harness.component.onInteract()
  assert.equal(harness.component.data.motionActive, false)
  assert.equal(harness.events.length, 1)
  harness.update({ active: true })
  assert.equal(harness.component.data.motionActive, true)
  assert.equal(harness.timers.size, 0)
})

test('reduced motion acknowledges taps with static expressions and no timers', () => {
  const harness = createMascot({ reducedMotion: true })
  harness.attach()
  assert.equal(harness.component.data.motionActive, false)
  harness.component.onInteract()
  assert.equal(harness.component.data.reaction, 'blink')
  assert.equal(harness.events.at(-1).detail.accepted, true)
  assert.equal(harness.events.at(-1).detail.animated, false)
  assert.equal(harness.timers.size, 0)
  harness.component.onInteract()
  assert.equal(harness.component.data.reaction, 'tilt')
  assert.equal(harness.timers.size, 0)
  harness.update({ state: 'thinking' })
  assert.equal(harness.component.data.reaction, '')
})

test('switching to reduced motion cancels a running reaction', () => {
  const harness = createMascot()
  harness.attach()
  harness.component.onInteract()
  harness.update({ reducedMotion: true })
  assert.equal(harness.component.data.motionActive, false)
  assert.equal(harness.component.data.reaction, '')
  assert.equal(harness.timers.size, 0)
})

test('decorative avatars emit no interaction and schedule no reaction', () => {
  const harness = createMascot({ decorative: true })
  harness.attach()
  harness.component.onInteract()
  assert.equal(harness.events.length, 0)
  assert.equal(harness.timers.size, 0)
  assert.equal(harness.component.data.reaction, '')
})

test('changing to decorative clears an existing reaction', () => {
  const harness = createMascot()
  harness.attach()
  harness.component.onInteract()
  harness.update({ decorative: true })
  assert.equal(harness.timers.size, 0)
  assert.equal(harness.component.data.reaction, '')
})

test('detaching clears the timer and no callback, lifecycle or tap writes after destruction', () => {
  const harness = createMascot()
  harness.attach()
  harness.component.onInteract()
  const callback = harness.history[0].callback
  harness.detach()
  assert.equal(harness.timers.size, 0)
  const updateCount = harness.updates.length
  const eventCount = harness.events.length
  callback()
  harness.component.onInteract()
  harness.show()
  harness.update({ active: true })
  assert.equal(harness.updates.length, updateCount)
  assert.equal(harness.events.length, eventCount)
})

test('pet behavior never makes a business request or schedules idle polling', () => {
  assert.doesNotMatch(source, /\bwx\.|\brequire\s*\(|\bfetch\s*\(|\bsetInterval\s*\(/)
})
