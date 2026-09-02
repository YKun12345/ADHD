const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

let definition
const storage = new Map([
  ['current_user', { id: 19, role: 'patient', full_name: '测试患者' }]
])

global.wx = {
  getStorageSync(key) { return storage.get(key) },
  setStorageSync(key, value) { storage.set(key, value) }
}
global.Component = (value) => { definition = value }

require('../components/onboarding-guide/index')

function instance(role = 'patient') {
  return {
    data: { ...definition.data, role, forceShow: false },
    events: [],
    setData(patch) { this.data = { ...this.data, ...patch } },
    triggerEvent(name, detail) { this.events.push({ name, detail }) },
    ...definition.methods
  }
}

const first = instance()
definition.lifetimes.attached.call(first)
assert.equal(first.data.visible, true)
assert.match(first.data.content.title, /ADHD 智慧辅助平台/)
assert.deepEqual(first.events.at(-1), { name: 'visibilitychange', detail: { visible: true } })
first.startUsing()
assert.equal(first.data.visible, false)
assert.equal(first.events.at(-1).name, 'dismiss')
assert.deepEqual(first.events.at(-2), { name: 'visibilitychange', detail: { visible: false } })

const second = instance()
definition.lifetimes.attached.call(second)
assert.equal(second.data.visible, false)
assert.deepEqual(second.events.at(-1), { name: 'visibilitychange', detail: { visible: false } })
second.show()
assert.equal(second.data.visible, true)
assert.deepEqual(second.events.at(-1), { name: 'visibilitychange', detail: { visible: true } })
second.skip()
assert.equal(second.data.visible, false)

const dir = path.join(__dirname, '..', 'components', 'onboarding-guide')
const wxml = fs.readFileSync(path.join(dir, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(dir, 'index.wxss'), 'utf8')
for (const fragment of [
  'catchtouchmove="stopTouch"',
  '星仔 · AI健康小助手',
  '我可以介绍页面、解释结果和提示下一步，但不能代替医生诊断。',
  'bindtap="skip"',
  'bindtap="startUsing"'
]) assert.equal(wxml.includes(fragment), true, `总引导缺少 ${fragment}`)
assert.match(wxss, /rgba\(7,\s*15,\s*20,\s*0\.72\)/)
assert.match(wxss, /z-index:\s*900/)
assert.match(wxss, /max-height:\s*calc\(100vh\s*-\s*[^)]+\)/)
assert.match(wxss, /overflow-y:\s*auto/)

console.log('登录总引导组件测试全部通过')
