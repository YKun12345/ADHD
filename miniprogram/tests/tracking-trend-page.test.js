const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { advancePatientDataRevision } = require('../utils/session-privacy')
let pageDefinition
let storage = { access_token: 'test-token', current_user: { id: 1, role: 'patient' }, tracking_local_logs: [{ day_index: 1, mood_tag: '4', attention_rating: 3, focus_minutes: 60 }] }
const drawCalls = []
const nextTicks = []
const context = new Proxy({}, { get(_, name) { return (...args) => { drawCalls.push([name, ...args]) } } })
global.wx = {
  getStorageSync(key) { return storage[key] },
  createCanvasContext(id) { drawCalls.push(['canvas', id]); return context },
  nextTick(callback) { nextTicks.push(callback) },
  navigateBack() {}
}
global.Page = (definition) => { pageDefinition = definition }
require('../pages/tracking-trend/index')
const page = { ...pageDefinition, data: JSON.parse(JSON.stringify(pageDefinition.data)), setData(patch, callback) { this.data = { ...this.data, ...patch }; if (callback) callback() } }
page.onShow()
nextTicks.shift()()
assert.equal(page.data.hasData, true)
assert.equal(page.data.activeMetric, 'mood')
assert.equal(page.data.averageValue, 4)
assert.equal(drawCalls.some((call) => call[0] === 'lineTo'), true)
page.selectMetric({ currentTarget: { dataset: { metric: 'focus' } } })
nextTicks.shift()()
assert.equal(page.data.activeMetric, 'focus')
assert.equal(page.data.metricUnit, '分钟')

page.onShow()
const drawCountBeforeSessionChange = drawCalls.length
advancePatientDataRevision()
nextTicks.shift()()
assert.equal(drawCalls.length, drawCountBeforeSessionChange)
assert.equal(typeof page.onPatientSessionEnded, 'function')
page.onPatientSessionEnded()
assert.equal(page._model, null)

const directory = path.join(__dirname, '..', 'pages', 'tracking-trend')
const wxml = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8')
for (const text of ['14天趋势', 'canvas-id="trendCanvas"', 'wx:for="{{metricTabs}}"', 'bindtap="selectMetric"', '{{averageValue}}', '暂无追踪数据', '不替代专业医生诊断']) assert.equal(wxml.includes(text), true, `WXML 缺少 ${text}`)
for (const selector of ['.trend-page', '.metric-tabs', '.metric-tab--active', '.chart-card', '.trend-canvas', '.empty-card']) assert.equal(wxss.includes(selector), true, `WXSS 缺少 ${selector}`)
console.log('追踪趋势页面测试全部通过')
