const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const directory = path.join(__dirname, '../components/ai-mascot')
const markup = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
const css = fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8')
function createMascot(properties = {}) {
  let definition, nextId = 0
  const timers = new Map(), updates = [], events = []
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'index.js'), 'utf8'), {
    Component(value) { definition = value },
    setTimeout(callback) { const id = ++nextId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) }
  })
  const defaults = Object.fromEntries(Object.entries(definition.properties).map(([key, value]) => [key, value.value]))
  const view = { ...definition.methods, data: { ...defaults, ...definition.data, ...properties },
    setData(patch) { Object.assign(this.data, patch); updates.push(patch) },
    triggerEvent(name, detail) { events.push({ name, detail }) } }
  definition.lifetimes.attached.call(view)
  return { view, timers, events, updates,
    update(patch) { Object.assign(view.data, patch); definition.observers['state, active, reducedMotion, decorative'].call(view) },
    hide() { definition.pageLifetimes.hide.call(view) },
    detach() { definition.lifetimes.detached.call(view) },
    finish() { const [id, callback] = [...timers][0]; timers.delete(id); callback() } }
}

test('the deployed local PNG has three square frames and transparency', () => {
  const filename = path.join(__dirname, '../assets/product/xingzai-sprite.png')
  assert.ok(fs.existsSync(filename), '必须部署真实星仔精灵图，不能用缺失资源宣称形象已替换')
  const png = fs.readFileSync(filename)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20) * 3)
  const colorType = png[25]
  assert.ok([4, 6].includes(colorType) || png.includes(Buffer.from('tRNS')), '精灵图须保留透明通道')
})

test('native image rendering clips one frame and isolates the old geometry behind load failure', () => {
  const image = markup.match(/<image\b[^>]*\/>/)[0]
  assert.match(image, /src="\{\{spriteSource\}\}"/)
  assert.match(image, /mode="scaleToFill"/)
  assert.match(image, /bindload="onSpriteLoad"/)
  assert.match(image, /binderror="onSpriteError"/)
  assert.match(markup, /class="ai-mascot__sprite-viewport"\s+wx:if="\{\{!spriteFailed\}\}"/)
  assert.match(markup, /class="ai-mascot__fallback"\s+wx:else/)
  assert.ok(markup.indexOf('ai-mascot__ear') > markup.indexOf('ai-mascot__fallback'))
  assert.match(css, /\.ai-mascot__sprite-viewport\s*\{[^}]*overflow:\s*hidden/s)
  const sheet = css.match(/\.ai-mascot__sprite-sheet\s*\{([^}]+)\}/)[1]
  assert.match(sheet, /width:\s*300%/)
  assert.match(sheet, /height:\s*100%/)
  assert.doesNotMatch(css, /(?:background|background-image)[^;]*url\(/)
  assert.match(css, /\.ai-mascot--paused \.ai-mascot__sprite-sheet/)
  assert.match(css, /@media[\s\S]*\.ai-mascot \.ai-mascot__sprite-sheet[\s\S]*animation:\s*none/)
})

test('real reactions select blink and wave frames while business states keep priority', () => {
  const h = createMascot()
  assert.equal(h.view.data.spriteFrame, 0)
  for (const [reaction, frame] of [['blink', 1], ['tilt', 0], ['wave', 2]]) {
    h.view.onInteract()
    assert.equal(h.view.data.reaction, reaction)
    assert.equal(h.view.data.spriteFrame, frame)
    h.finish()
    assert.equal(h.view.data.spriteFrame, 0)
  }
  h.update({ state: 'thinking' })
  h.view.onInteract()
  assert.equal(h.view.data.spriteFrame, 0)
  assert.equal(h.view.data.reaction, '')
  h.update({ state: 'success' })
  assert.equal(h.view.data.spriteFrame, 2)
  h.update({ state: 'sleep' })
  assert.equal(h.view.data.spriteFrame, 1)
  h.detach()
})

test('load acknowledgement validates the sheet and image failure is explicit without timers', () => {
  const h = createMascot()
  assert.equal(h.view.data.spriteSource, '/assets/product/xingzai-sprite.png')
  assert.equal(h.view.data.spriteReady, false)
  h.view.onSpriteLoad({ detail: { width: 2172, height: 724 } })
  assert.equal(h.view.data.spriteReady, true)
  assert.equal(h.view.data.spriteFailed, false)
  h.view.onSpriteError()
  assert.equal(h.view.data.spriteReady, false)
  assert.equal(h.view.data.spriteFailed, true)
  assert.equal(h.events.at(-1).name, 'rendererror')
  assert.equal(h.timers.size, 0)
  h.detach()
  const malformed = createMascot()
  malformed.view.onSpriteLoad({ detail: { width: 724, height: 724 } })
  assert.equal(malformed.view.data.spriteReady, false)
  assert.equal(malformed.view.data.spriteFailed, true)
  malformed.detach()
})

test('reduced motion retains static frames and hidden or destroyed pets cannot keep moving', () => {
  const h = createMascot({ reducedMotion: true })
  h.view.onInteract()
  assert.equal(h.view.data.spriteFrame, 1)
  assert.equal(h.view.data.motionActive, false)
  assert.equal(h.timers.size, 0)
  h.hide()
  assert.equal(h.view.data.spriteFrame, 0)
  h.detach()
  const count = h.updates.length
  h.view.onSpriteLoad({ detail: { width: 2172, height: 724 } })
  h.view.onSpriteError()
  assert.equal(h.updates.length, count)
})
