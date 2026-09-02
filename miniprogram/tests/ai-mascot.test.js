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

const directory = path.join(__dirname, '..', 'components', 'ai-mascot')
const json = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'))
const wxml = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8')

assert.equal(json.component, true)
assert.equal(json.styleIsolation, 'isolated')
assert.match(wxml, /ai-mascot--\{\{state\}\}/)
assert.match(wxml, /aria-label="\{\{decorative \? '' : label\}\}"/)
assert.match(wxml, /aria-hidden="\{\{decorative\}\}"/)
for (const part of ['ai-mascot__ear', 'ai-mascot__face', 'ai-mascot__eye', 'ai-mascot__cheek', 'ai-mascot__coat', 'ai-mascot__stethoscope', 'ai-mascot__badge', 'ai-mascot__arm']) {
  assert.equal(wxml.includes(part), true, `宠物结构缺少 ${part}`)
}
for (const state of ['idle', 'wave', 'happy', 'thinking', 'listening', 'guide', 'care']) {
  assert.match(wxss, new RegExp(`\\.ai-mascot--${state}`))
}
assert.match(wxss, /@keyframes\s+mascotBreathe/)
assert.match(wxss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
assert.doesNotMatch(wxml, /[\u{1F300}-\u{1FAFF}]/u)

console.log('AI 宠物星仔组件测试全部通过')
