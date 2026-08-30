const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

const pages = ['report', 'tracking', 'tracking-trend']
for (const page of pages) {
  const config = JSON.parse(read('pages', page, 'index.json'))
  const wxml = read('pages', page, 'index.wxml')
  const wxss = read('pages', page, 'index.wxss')

  assert.equal(
    config.usingComponents && config.usingComponents['ui-icon'],
    '/components/ui-icon/index',
    `${page} should register ui-icon`
  )
  assert.match(wxml, /<ui-icon\b/, `${page} should use a semantic icon`)
  assert.match(wxml, /glass-surface/, `${page} should use the shared glass surface`)
  assert.doesNotMatch(wxss, /:active|\[disabled\]|backdrop-filter|display\s*:\s*grid/i)
  assert.doesNotMatch(wxml, /[\u{1F300}-\u{1FAFF}]/u)
}

const reportWxml = read('pages', 'report', 'index.wxml')
const reportWxss = read('pages', 'report', 'index.wxss')
const reportJs = read('pages', 'report', 'index.js')
assert.match(reportWxml, /name="report"[\s\S]*shape="sheet"/)
assert.match(reportWxml, /type="2d"[\s\S]*id="reportRadarCanvas"/)
assert.match(reportWxml, /type="2d"[\s\S]*id="reportTrendCanvas"/)
assert.match(reportWxml, /id="reportRadarCanvas"[\s\S]*aria-label="行为量表维度雷达图"/)
assert.match(reportWxml, /id="reportTrendCanvas"[\s\S]*aria-label="14天注意力趋势图"/)
assert.match(reportWxml, /radarStatusMessage/)
assert.match(reportWxml, /trendStatusMessage/)
assert.doesNotMatch(reportWxml, /canvasStatusMessage/)
assert.doesNotMatch(reportWxml, /canvas-id=/)
assert.match(reportWxml, /chart-legend/)
assert.match(reportWxml, /axis-label/)
assert.match(reportWxml, /chart-data-summary/)
assert.match(reportWxml, /第1天[\s\S]*第7天[\s\S]*第14天/)
assert.match(
  reportWxml,
  /<view\s+wx:if="\{\{!tracking\.hasTrend\}\}"\s+class="empty-panel">同步数据暂未包含可绘制的注意力趋势<\/view>/,
  'tracking empty state should be explicitly tied to missing trend data'
)
assert.doesNotMatch(
  reportWxml,
  /canvasStatusMessage[\s\S]*?<\/text>\s*<view\s+wx:else\s+class="empty-panel">同步数据暂未包含可绘制的注意力趋势/,
  'tracking empty state must not bind wx:else to the canvas status message'
)
assert.match(reportWxml, /empty-panel|status-message/)
assert.match(reportWxss, /\.radar-canvas\s*\{[^}]*width\s*:\s*100%/s)
assert.match(reportWxss, /\.trend-canvas\s*\{[^}]*width\s*:\s*100%/s)
assert.doesNotMatch(reportWxss, /330px|620rpx/)

const trendWxml = read('pages', 'tracking-trend', 'index.wxml')
const trendWxss = read('pages', 'tracking-trend', 'index.wxss')
const trendJs = read('pages', 'tracking-trend', 'index.js')
assert.match(trendWxml, /name="tracking"[\s\S]*shape="lens"/)
assert.match(trendWxml, /type="2d"[\s\S]*id="trackingTrendCanvas"/)
assert.match(trendWxml, /id="trackingTrendCanvas"[\s\S]*aria-label="14天状态变化趋势图"/)
assert.doesNotMatch(trendWxml, /canvas-id=/)
assert.match(trendWxml, /chart-legend/)
assert.match(trendWxml, /axis-label/)
assert.match(trendWxml, /aria-role="radiogroup"/)
assert.match(trendWxml, /aria-role="radio"[\s\S]*aria-checked=/)
assert.match(trendWxml, /chart-data-summary/)
assert.match(trendWxml, /\{\{rangeMinimum\}\}[\s\S]*\{\{rangeMidpoint\}\}[\s\S]*\{\{rangeMaximum\}\}/)
assert.match(trendWxml, /空白日期/)
assert.match(trendWxss, /\.trend-canvas\s*\{[^}]*width\s*:\s*100%/s)
assert.doesNotMatch(trendWxss, /330px|620rpx/)

const trackingWxml = read('pages', 'tracking', 'index.wxml')
assert.match(trackingWxml, /name="tracking"[\s\S]*shape="lens"/)

for (const [name, source, expectedIds] of [
  ['report', reportJs, ['#reportRadarCanvas', '#reportTrendCanvas']],
  ['tracking-trend', trendJs, ['#trackingTrendCanvas']]
]) {
  assert.match(source, /require\(['"]\.\.\/\.\.\/utils\/canvas-scale['"]\)/)
  assert.match(source, /createSelectorQuery\(\)/)
  assert.match(source, /fields\(\{\s*node\s*:\s*true\s*,\s*size\s*:\s*true\s*\}\)/)
  assert.match(source, /canvas\.width\s*=\s*metrics\.pixelWidth/)
  assert.match(source, /canvas\.height\s*=\s*metrics\.pixelHeight/)
  assert.match(source, /context\.scale\(metrics\.dpr\s*,\s*metrics\.dpr\)/)
  assert.match(source, /measureText/)
  assert.match(source, /getWindowInfo/)
  assert.match(source, /getSystemInfoSync/)
  assert.doesNotMatch(source, /createCanvasContext/)
  for (const id of expectedIds) assert.ok(source.includes(id), `${name} should query ${id}`)
}

assert.match(reportJs, /if\s*\(this\._canvasDisposed\)\s*return[\s\S]*this\._drawCharts\(\)/)
assert.match(reportJs, /_drawCharts\(\)\s*\{\s*if\s*\(this\._canvasDisposed\)\s*return/)
assert.match(trendJs, /_drawChart\(metric\)\s*\{\s*if\s*\(this\._canvasDisposed\)\s*return/)
assert.match(trendJs, /renderToken/)
assert.match(trendJs, /this\._chartRenderToken/)
assert.match(trendJs, /this\.data\.activeMetric\s*!==\s*metric/)
for (const source of [reportJs, trendJs]) {
  assert.match(source, /fillText/)
  assert.match(source, /gridValues/)
}

console.log('report and tracking visual contracts passed')
