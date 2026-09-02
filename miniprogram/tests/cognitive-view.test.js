const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pageDirectory = path.join(
  __dirname,
  '..',
  'pages',
  'cognitive'
)

const wxml = fs.readFileSync(
  path.join(pageDirectory, 'index.wxml'),
  'utf8'
)
const wxss = fs.readFileSync(
  path.join(pageDirectory, 'index.wxss'),
  'utf8'
)
const appConfig = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'app.json'),
    'utf8'
  )
)

assert.equal(
  appConfig.pages.includes('pages/cognitive/index'),
  true,
  'app.json 缺少 pages/cognitive/index 路由'
)

const requiredWxml = [
  'Go / No-Go 认知测试',
  '看到绿色“点击”时请尽快点击',
  '看到红色“停”时请保持不动',
  'bindtap="startTest"',
  '{{currentTrialNumber}} / {{totalTrials}}',
  "style=\"{{'width: ' + progressPercent + '%;'}}\"",
  "phase === 'waiting' || phase === 'stimulus' || phase === 'feedback'",
  'bindtap="handleTestTap"',
  '{{stimulusLabel}}',
  '{{feedbackText}}',
  "phase === 'break'",
  '{{breakTitle}}',
  '{{breakMessage}}',
  'bindtap="continueSection"',
  "phase === 'result'",
  '{{result.accuracy}}%',
  '{{result.average_reaction_time_ms}}',
  '{{result.go_accuracy}}%',
  '{{result.nogo_accuracy}}%',
  '{{result.commission_errors}}',
  '{{result.omission_errors}}',
  '{{result.false_starts}}',
  '{{syncStatus}}',
  'bindtap="retrySync"',
  'bindtap="restartTest"',
  'bindtap="goBack"',
  '本任务仅用于辅助筛查，不替代专业认知评估或医生诊断'
]

for (const fragment of requiredWxml) {
  assert.equal(
    wxml.includes(fragment),
    true,
    `WXML 缺少：${fragment}`
  )
}

const requiredSelectors = [
  '.cognitive-page',
  '.cognitive-shell--testing',
  '.instruction-card',
  '.rule-item--go',
  '.rule-item--nogo',
  '.test-card',
  '.test-progress-value',
  '.test-stage',
  '.stimulus-circle--go',
  '.stimulus-circle--nogo',
  '.feedback-text',
  '.section-break-card',
  '.result-card',
  '.result-grid',
  '.sync-badge',
  '.primary-button',
  '.medical-tip'
]

for (const selector of requiredSelectors) {
  assert.equal(
    wxss.includes(selector),
    true,
    `WXSS 缺少：${selector}`
  )
}

const testStageRule = wxss.match(/(?:^|\n)\.test-stage\s*\{([^}]*)\}/)
assert.ok(testStageRule, 'WXSS 缺少 .test-stage 规则')
assert.match(testStageRule[1], /min-height:\s*520rpx/)
assert.match(testStageRule[1], /user-select:\s*none/)

const primaryButtonRule = wxss.match(/\.primary-button\s*\{([^}]*)\}/)
assert.ok(primaryButtonRule, 'WXSS 缺少 .primary-button 规则')
assert.match(primaryButtonRule[1], /display:\s*flex/)
assert.match(primaryButtonRule[1], /align-items:\s*center/)
assert.match(primaryButtonRule[1], /justify-content:\s*center/)

console.log('Go/No-Go 页面视图结构测试全部通过')
