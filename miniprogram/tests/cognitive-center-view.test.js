const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pageDirectory = path.join(
  __dirname,
  '..',
  'pages',
  'cognitive-center'
)
const wxml = fs.readFileSync(path.join(pageDirectory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(pageDirectory, 'index.wxss'), 'utf8')
const appConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8')
)

for (const route of [
  'pages/simple-reaction/index',
  'pages/trail/index',
  'pages/flanker/index',
  'pages/nback/index',
  'pages/digit-span/index'
]) {
  assert.equal(appConfig.pages.includes(route), true, `app.json 缺少 ${route} 路由`)
}

assert.equal(
  appConfig.pages.includes('pages/cognitive-center/index'),
  true,
  'app.json 缺少 pages/cognitive-center/index 路由'
)

const requiredWxml = [
  '认知测试中心',
  '{{completedCount}} / {{totalCount}}',
  "style=\"{{'width: ' + progressPercent + '%;'}}\"",
  '{{summaryText}}',
  'wx:for="{{groups}}"',
  'wx:for="{{group.cards}}"',
  '{{group.title}}',
  'data-id="{{item.id}}"',
  'bindtap="handleTestTap"',
  'bindtap="startOrResumeBattery"',
  '{{batteryActionText}}',
  '预计剩余 {{remainingMinutes}} 分钟',
  '轻量移动筛查版',
  '短任务单节完成，长任务会分节休息',
  '{{item.title}}',
  '{{item.description}}',
  '{{item.primaryMetric}}',
  '{{item.statusLabel}}',
  "item.completed ? 'test-card--completed' : ''",
  '<ui-nav title="认知测试中心" />',
  '本中心仅汇总任务完成情况和客观指标，不替代专业医生诊断'
]

for (const fragment of requiredWxml) {
  assert.equal(wxml.includes(fragment), true, `WXML 缺少：${fragment}`)
}

const requiredSelectors = [
  '.cognitive-center-page',
  '.summary-card',
  '.summary-progress-value',
  '.test-list',
  '.test-card',
  '.test-card--completed',
  '.test-icon',
  '.test-metric',
  '.test-action',
  '.medical-tip'
]

for (const selector of requiredSelectors) {
  assert.equal(wxss.includes(selector), true, `WXSS 缺少：${selector}`)
}

console.log('认知测试中心视图结构测试全部通过')
