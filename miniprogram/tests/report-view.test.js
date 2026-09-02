const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pageDirectory = path.join(
  __dirname,
  '..',
  'pages',
  'report'
)
const wxml = fs.readFileSync(
  path.join(pageDirectory, 'index.wxml'),
  'utf8'
)
const wxss = fs.readFileSync(
  path.join(pageDirectory, 'index.wxss'),
  'utf8'
)
const appConfig = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'app.json'),
  'utf8'
))

assert.match(wxml, /bindtap="toggleProfessional"/)
assert.match(wxml, /专业评估结果/)
assert.match(wxml, /不可独立用于诊断/)
assert.match(wxml, /professionalExpanded/)
const professionalBlockEnd = wxml.indexOf('</block>', wxml.indexOf('wx:if="{{professionalExpanded}}"'))
const fixedDisclaimer = wxml.indexOf('本结果来自辅助分析模型，仅供专业人员结合其他资料参考，不可独立用于诊断。')
assert.ok(fixedDisclaimer > professionalBlockEnd, '专业模型免责声明必须在默认折叠区域外固定显示')

assert.equal(
  appConfig.pages.includes('pages/report/index'),
  true,
  'app.json 缺少综合报告路由'
)

const requiredWxml = [
  '综合辅助筛查报告',
  '{{patientName}}',
  '{{patientTypeLabel}}',
  '{{sourceLabel}}',
  '{{coverage.percent}}%',
  'coverage-bar__value--{{coverage.completedCount}}',
  '行为量表',
  '{{scale.totalScore}}',
  '{{scale.riskLabel}}',
  'type="2d"',
  'id="reportRadarCanvas"',
  'wx:if="{{scale.hasRadar}}"',
  '暂无完整雷达数据',
  '认知测试',
  'wx:for="{{cognitive.cards}}"',
  '{{item.primaryMetric}}',
  '14天追踪',
  '{{tracking.averageAttention}}',
  'id="reportTrendCanvas"',
  'wx:if="{{tracking.hasTrend}}"',
  'bindtap="openTask"',
  'data-task="scale"',
  'data-task="cognitive"',
  'data-task="tracking"',
  'bindtap="openTrend"',
  '暂无专业评估记录',
  '仅用于辅助筛查，不替代专业医生诊断'
]

for (const fragment of requiredWxml) {
  assert.equal(
    wxml.includes(fragment),
    true,
    `WXML 缺少：${fragment}`
  )
}

const requiredSelectors = [
  '.report-page',
  '.summary-card',
  '.source-badge',
  '.coverage-bar',
  '.coverage-bar__value--0',
  '.coverage-bar__value--1',
  '.coverage-bar__value--2',
  '.coverage-bar__value--3',
  '.report-card',
  '.metric-grid',
  '.radar-canvas',
  '.cognitive-item',
  '.trend-canvas',
  '.empty-panel',
  '.task-button',
  '.medical-tip'
]

for (const selector of requiredSelectors) {
  assert.equal(
    wxss.includes(selector),
    true,
    `WXSS 缺少：${selector}`
  )
}

const taskButtonRule = wxss.match(/\.task-button\s*\{([^}]*)\}/)
assert.ok(taskButtonRule, 'WXSS 缺少 .task-button 样式规则')
assert.match(taskButtonRule[1], /display:\s*flex/)
assert.match(taskButtonRule[1], /align-items:\s*center/)
assert.match(taskButtonRule[1], /justify-content:\s*center/)

console.log('综合报告页面视图结构测试全部通过')
