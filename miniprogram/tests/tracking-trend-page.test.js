const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { advancePatientDataRevision } = require('../utils/session-privacy')
let pageDefinition
let storage = { access_token: 'test-token', current_user: { id: 1, role: 'patient' }, tracking_local_logs: [
  { day_index: 1, mood_tag: '4', attention_rating: 3, focus_minutes: 1440 },
  { day_index: 3, mood_tag: '2', attention_rating: 5, focus_minutes: 0 },
  { day_index: 14, mood_tag: '5', attention_rating: 1, focus_minutes: 720 }
] }
const drawCalls = []
const nextTicks = []
const selectorCallbacks = []
let deferCanvasQueries = false
let measuredWidth = 320
let measuredHeight = 240
let pixelRatio = 3
const context = new Proxy({}, {
  get(target, name) {
    if (name in target) return target[name]
    if (name === 'measureText') return (value) => ({ width: String(value).length * 7 })
    return (...args) => { drawCalls.push([name, ...args]) }
  },
  set(target, name, value) { target[name] = value; drawCalls.push([name, value]); return true }
})
const canvas = { width: 0, height: 0, getContext() { return context } }
global.wx = {
  getStorageSync(key) { return storage[key] },
  getWindowInfo() { return { pixelRatio } },
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
    const queries = []
    return {
      select(selector) { queries.push({ selector }); return this },
      fields(options) { queries[queries.length - 1].options = options; return this },
      boundingClientRect() { queries[queries.length - 1].rectangle = true; return this },
      exec(callback) {
        drawCalls.push(['query', queries.map((query) => query.selector)])
        const result = queries.map((query) => query.rectangle
          ? { width: measuredWidth, height: measuredHeight, left: 50, top: 600 }
          : { node: canvas, width: 300, height: 150 })
        if (deferCanvasQueries) selectorCallbacks.push(() => callback(result))
        else callback(result)
      }
    }
  }
}
function flushTicks() { while (nextTicks.length) nextTicks.shift()() }
function choose(metric) { page.selectMetric({ currentTarget: { dataset: { metric } } }); flushTicks() }

page.onShow()
flushTicks()
assert.equal(page.data.hasData, true)
assert.equal(page.data.activeMetric, 'mood')
assert.equal(page.data.averageValue, 4)
const dateLabels = drawCalls.filter((call) => call[0] === 'fillText' && /^第\d+天$/.test(call[1]))
assert.deepEqual(dateLabels.map((call) => call[1]), ['第1天', '第7天', '第14天'], 'dates must be drawn inside the same canvas as the data')
assert.equal(canvas.width, measuredWidth * pixelRatio, 'physical width must come from the fixed plot wrapper, not an intrinsic canvas size')
assert.equal(canvas.height, measuredHeight * pixelRatio)
assert.equal(page.data.chartCanvasWidth, measuredWidth, 'native canvas must have an explicit CSS pixel width')
assert.equal(page.data.chartCanvasHeight, measuredHeight)
assert.deepEqual(drawCalls.find((call) => call[0] === 'clearRect'), ['clearRect', 0, 0, canvas.width, canvas.height], 'clear physical pixels before applying the logical-coordinate transform')
assert.deepEqual(drawCalls.filter((call) => call[0] === 'setTransform').slice(0, 2), [
  ['setTransform', 1, 0, 0, 1, 0, 0], ['setTransform', pixelRatio, 0, 0, pixelRatio, 0, 0]
], 'each redraw resets its origin and scale, rather than accumulating transforms')
assert.equal(drawCalls.filter((call) => call[0] === 'moveTo').length >= 3, true, 'missing dates restart the curve at each isolated point')
assert.ok(drawCalls.some((call) => call[0] === 'clip'), 'drawing is clipped to the plot bounds')
for (const point of drawCalls.filter((call) => call[0] === 'arc')) {
  assert.ok(point[1] >= 0 && point[1] <= measuredWidth && point[2] >= 0 && point[2] <= measuredHeight, 'all points stay within the local plot wrapper')
}

drawCalls.length = 0
choose('focus')
assert.equal(page.data.metricUnit, '分钟')
assert.equal(page.data.averageValue, 720)
assert.equal(page.data.rangeMinimum, 0)
assert.equal(page.data.rangeMaximum, 1440)
const highValueLabel = drawCalls.find((call) => call[0] === 'fillText' && call[1] === '1440')
assert.ok(highValueLabel && highValueLabel[2] - 28 >= 8, 'high-value Y-axis label stays inside the plot wrapper')
assert.ok(drawCalls.some((call) => call[0] === 'clearRect'), 'switching a metric clears the previous drawing')
choose('attention')
assert.equal(page.data.metricUnit, '分')
assert.equal(page.data.rangeMinimum, 1)
assert.equal(page.data.rangeMaximum, 5)
assert.equal(page.data.averageValue, 3)

for (const [width, height, ratio] of [[240, 190, 1], [320, 240, 2], [428, 280, 3], [319.5, 230.25, 2.75]]) {
  measuredWidth = width; measuredHeight = height; pixelRatio = ratio
  drawCalls.length = 0
  page.onResize()
  flushTicks()
  assert.equal(canvas.width, Math.round(width * ratio))
  assert.equal(canvas.height, Math.round(height * ratio))
  assert.equal(page.data.activeMetric, 'attention', 'resizing preserves the selected metric')
  for (const call of drawCalls.filter((item) => item[0] === 'arc' || item[0] === 'fillText')) {
    const x = call[0] === 'arc' ? call[1] : call[2]
    const y = call[0] === 'arc' ? call[2] : call[3]
    assert.ok(x >= 0 && x <= width && y >= 0 && y <= height, 'logical coordinates never use page top or physical pixels')
  }
}

deferCanvasQueries = true
choose('mood')
choose('focus')
assert.equal(selectorCallbacks.length, 2)
selectorCallbacks.pop()()
flushTicks()
const drawCountAfterLatestMetric = drawCalls.length
selectorCallbacks.shift()()
flushTicks()
assert.equal(drawCalls.length, drawCountAfterLatestMetric, 'late callback cannot draw over a newer metric')

choose('attention')
page.onHide()
const drawCountWhileHidden = drawCalls.length
selectorCallbacks.shift()()
flushTicks()
assert.equal(drawCalls.length, drawCountWhileHidden, 'hidden-page queries must not draw')
deferCanvasQueries = false
page.onShow()
flushTicks()
assert.equal(page.data.activeMetric, 'attention', 'returning redraws the current metric')
assert.ok(drawCalls.length > drawCountWhileHidden)

page.onResize()
const queriesBeforeUnload = drawCalls.filter((call) => call[0] === 'query').length
page.onUnload()
flushTicks()
assert.equal(drawCalls.filter((call) => call[0] === 'query').length, queriesBeforeUnload, 'unloaded page cancels queued remeasurement')

page.onShow()
const drawCountBeforeSessionChange = drawCalls.length
advancePatientDataRevision()
flushTicks()
assert.equal(drawCalls.length, drawCountBeforeSessionChange)
page.onPatientSessionEnded()
assert.equal(page._model, null)

const directory = path.join(__dirname, '..', 'pages', 'tracking-trend')
const wxml = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8')
assert.match(wxml, /id="trackingTrendPlot"[\s\S]*<canvas[\s\S]*id="trackingTrendCanvas"/)
assert.match(wxml, /style="[^"]*chartCanvasWidth[^"]*chartCanvasHeight/)
assert.match(wxss, /\.chart-plot\s*\{[^}]*position\s*:\s*relative[^}]*height\s*:\s*440rpx/s)
assert.match(wxss, /\.trend-canvas\s*\{[^}]*position\s*:\s*absolute[^}]*top\s*:\s*0[^}]*left\s*:\s*0/s)
console.log('追踪趋势页面测试全部通过')
