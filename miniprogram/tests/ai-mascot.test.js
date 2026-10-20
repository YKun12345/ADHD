const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

let componentDefinition
global.Component = (definition) => {
  componentDefinition = definition
}

require('../components/ai-mascot/index')

assert.equal(componentDefinition.properties.state.type, String)
assert.equal(componentDefinition.properties.state.value, 'idle')
assert.equal(componentDefinition.properties.label.value, '星仔 · AI健康小助手')
assert.equal(componentDefinition.properties.decorative.type, Boolean)
assert.equal(componentDefinition.properties.active?.type, Boolean)
assert.equal(componentDefinition.properties.active.value, true)
assert.equal(componentDefinition.properties.reducedMotion.type, Boolean)
assert.equal(componentDefinition.properties.reducedMotion.value, false)

const directory = path.join(__dirname, '..', 'components', 'ai-mascot')
const json = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'))
const wxml = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8')

assert.equal(json.component, true)
assert.equal(json.styleIsolation, 'isolated')
assert.match(wxml, /ai-mascot--\{\{state\}\}/)
assert.match(wxml, /aria-label="\{\{decorative \? '' : label\}\}"/)
assert.match(wxml, /aria-hidden="\{\{decorative\}\}"/)
assert.match(wxml, /bindtap="onInteract"/)
assert.match(wxml, /ai-mascot--react-\{\{reaction\}\}/)
assert.match(wxml, /motionActive\s*\?\s*''\s*:\s*'ai-mascot--paused'/)
for (const part of ['ai-mascot__ear', 'ai-mascot__face', 'ai-mascot__eye', 'ai-mascot__cheek', 'ai-mascot__coat', 'ai-mascot__stethoscope', 'ai-mascot__badge', 'ai-mascot__arm']) {
  assert.equal(wxml.includes(part), true, `宠物结构缺少 ${part}`)
}
for (const state of ['idle', 'wave', 'happy', 'thinking', 'listening', 'guide', 'care', 'waiting', 'success', 'recover', 'sleep']) {
  assert.match(wxss, new RegExp(`\\.ai-mascot--${state}`))
}
assert.match(wxss, /@keyframes\s+mascotBreathe/)
assert.match(wxss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
for (const reaction of ['blink', 'tilt', 'wave']) {
  assert.match(wxss, new RegExp(`\\.ai-mascot--react-${reaction}`))
}
for (const part of ['face', 'spark', 'eye', 'arm']) {
  assert.match(wxss, new RegExp(`\\.ai-mascot--paused \\.ai-mascot__${part}`))
  assert.match(wxss, new RegExp(`@media[\\s\\S]*\\.ai-mascot \\.ai-mascot__${part}[\\s\\S]*animation:\\s*none`))
}
assert.doesNotMatch(wxss, /transition:\s*height/)
const keyframes = [...wxss.matchAll(/@keyframes\s+(\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
assert.ok(keyframes.length > 0)
for (const [, name, body] of keyframes) {
  const declarations = [...body.matchAll(/([a-z-]+)\s*:/g)]
  assert.ok(declarations.length > 0, `动画 ${name} 应包含可核对的声明`)
  for (const declaration of declarations) {
    assert.ok(['transform', 'opacity'].includes(declaration[1]), `动画不应改变 ${declaration[1]}`)
  }
}
assert.doesNotMatch(wxml, /[\u{1F300}-\u{1FAFF}]/u)

console.log('AI 宠物星仔组件测试全部通过')
