const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pageDirectory = path.join(__dirname, '..', 'pages', 'stroop')
const wxml = fs.readFileSync(path.join(pageDirectory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(pageDirectory, 'index.wxss'), 'utf8')
const appConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8')
)

assert.equal(
  appConfig.pages.includes('pages/stroop/index'),
  true,
  'app.json 缺少 pages/stroop/index 路由'
)

const requiredWxml = [
  'Stroop 颜色词测试',
  '判断文字的实际颜色，而不是文字本身的含义',
  'bindtap="startTest"',
  '{{currentTrialNumber}} / {{totalTrials}}',
  'style="width: {{progressPercent}}%;"',
  'style="color: {{currentColorHex}};"',
  '{{currentWord}}',
  'wx:for="{{colors}}"',
  'data-key="{{item.key}}"',
  'bindtap="handleAnswer"',
  '{{item.label}}',
  '{{feedbackText}}',
  '{{result.accuracy}}%',
  '{{result.average_reaction_time_ms}}',
  '{{result.congruent_accuracy}}%',
  '{{result.incongruent_accuracy}}%',
  '{{result.correct}}',
  '{{result.wrong}}',
  '{{syncStatus}}',
  'bindtap="retrySync"',
  'bindtap="restartTest"',
  'bindtap="goBack"',
  '本任务仅用于辅助筛查，不替代专业认知评估或医生诊断'
]

for (const fragment of requiredWxml) {
  assert.equal(wxml.includes(fragment), true, `WXML 缺少：${fragment}`)
}

const requiredSelectors = [
  '.stroop-page',
  '.stroop-nav',
  '.instruction-card',
  '.example-word',
  '.test-card',
  '.stroop-word',
  '.color-grid',
  '.color-button',
  '.feedback-panel',
  '.result-card',
  '.result-grid',
  '.sync-badge',
  '.primary-button',
  '.medical-tip'
]

for (const selector of requiredSelectors) {
  assert.equal(wxss.includes(selector), true, `WXSS 缺少：${selector}`)
}

const colorButtonRule = wxss.match(/\.color-button\s*\{([^}]*)\}/)
assert.ok(colorButtonRule, 'WXSS 缺少 .color-button 规则')
assert.match(colorButtonRule[1], /display:\s*flex/)
assert.match(colorButtonRule[1], /align-items:\s*center/)
assert.match(colorButtonRule[1], /justify-content:\s*center/)
assert.match(colorButtonRule[1], /min-height:\s*96rpx/)

console.log('Stroop 页面视图结构测试全部通过')
