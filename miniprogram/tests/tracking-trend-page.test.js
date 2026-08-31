const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { advancePatientDataRevision } = require('../utils/session-privacy')
let pageDefinition
let storage = { access_token: 'test-token', current_user: { id: 1, role: 'patient' }, tracking_local_logs: [{ day_index: 1, mood_tag: '4', attention_rating: 3, focus_minutes: 1440 }] }
const drawCalls = []
const nextTicks = []
const selectorCallbacks = []
let deferCanvasQueries = false
const context = new Proxy({}, {
  get(target, name) {
    if (name in target) return target[name]
    if (name === 'measureText') {
      return (value) => {
        drawCalls.push([name, value])
        return { width: String(value).length * 7 }
      }
    }
    return (...args) => { drawCalls.push([name, ...args]) }
  },
  set(target, name, value) {
    target[name] = value
    drawCalls.push([name, value])
    return true
  }
})
global.wx = {
  getStorageSync(key) { return storage[key] },
  getWindowInfo() { return { pixelRatio: 3 } },
  nextTick(callback) { nextTicks.push(callback) },
  navigateBack() {}
}
global.Page = (definition) => { pageDefinition = definition }
require('../pages/tracking-trend/index')
const page = {
  ...pageDefinition,
  data: JSON.parse(JSON.stringify(pageDefinition.data)),
  setData(patch, callback) { this.data = { ...this.data, ...patch }; if (callback) callback() },
  createSelectorQuery() {
    let selector = ''
    return {
      select(value) { selector = value; return this },
      fields() { return this },
      exec(callback) {
        drawCalls.push(['canvas', selector.replace(/^#/, '')])
        const result = [{
          node: { width: 0, height: 0, getContext() { return context } },
          width: 320,
          height: 220
        }]
        if (deferCanvasQueries) selectorCallbacks.push(() => callback(result))
        else callback(result)
      }
    }
  }
}
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
assert.equal(
  drawCalls.some((call) => call[0] === 'measureText' && call[1] === '1440'),
  true,
  'focus chart should measure its high-value Y-axis label before laying out the plot'
)
const highValueLabel = drawCalls.find((call) => call[0] === 'fillText' && call[1] === '1440')
assert.ok(highValueLabel, 'focus chart should render the 1440 Y-axis label')
assert.equal(
  highValueLabel[2] - (String(highValueLabel[1]).length * 7) >= 8,
  true,
  '1440 Y-axis label should remain inside a 320px canvas'
)

deferCanvasQueries = true
page.onShow()
nextTicks.shift()()
page.selectMetric({ currentTarget: { dataset: { metric: 'focus' } } })
nextTicks.shift()()
assert.equal(selectorCallbacks.length, 2)
selectorCallbacks.pop()()
const drawCountAfterLatestMetric = drawCalls.length
selectorCallbacks.shift()()
assert.equal(
  drawCalls.length,
  drawCountAfterLatestMetric,
  'late callback for an older metric must not draw over the latest chart'
)
deferCanvasQueries = false

page.onShow()
const canvasQueriesBeforeUnload = drawCalls.filter((call) => call[0] === 'canvas').length
page.onUnload()
nextTicks.shift()()
assert.equal(
  drawCalls.filter((call) => call[0] === 'canvas').length,
  canvasQueriesBeforeUnload,
  'unloaded trend page must not create a selector query'
)

page.onShow()
const drawCountBeforeSessionChange = drawCalls.length
advancePatientDataRevision()
nextTicks.shift()()
assert.equal(drawCalls.length, drawCountBeforeSessionChange)
assert.equal(typeof page.onPatientSessionEnded, 'function')
page.onPatientSessionEnded()
assert.equal(page._model, null)

assert.equal(
  drawCalls.filter((call) => call[0] === 'fillText').length >= 3,
  true,
  'trend chart should draw readable Y-axis labels'
)

const directory = path.join(__dirname, '..', 'pages', 'tracking-trend')
const wxml = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8')
for (const text of ['14天趋势', 'type="2d"', 'id="trackingTrendCanvas"', 'wx:for="{{metricTabs}}"', 'bindtap="selectMetric"', '{{averageValue}}', '暂无追踪数据', '不替代专业医生诊断']) assert.equal(wxml.includes(text), true, `WXML 缺少 ${text}`)
for (const selector of ['.trend-page', '.metric-tabs', '.metric-tab--active', '.chart-card', '.trend-canvas', '.empty-card']) assert.equal(wxss.includes(selector), true, `WXSS 缺少 ${selector}`)
console.log('追踪趋势页面测试全部通过')
