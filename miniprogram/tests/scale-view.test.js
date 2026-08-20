const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pageDirectory = path.join(
  __dirname,
  '..',
  'pages',
  'scale'
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
  appConfig.pages.includes('pages/scale/index'),
  true,
  'app.json 缺少 pages/scale/index 路由'
)

const requiredWxml = [
  '{{title}}',
  '{{instructions}}',
  'wx:if="{{!patientSupported}}"',
  '{{unsupportedMessage}}',
  'wx:elif="{{showResult}}"',
  '{{questionNumber}} / {{totalQuestions}}',
  'style="width: {{progressPercent}}%;"',
  '{{currentQuestion}}',
  'wx:for="{{options}}"',
  'data-value="{{item.value}}"',
  'bindtap="selectOption"',
  "selectedValue === item.value ? 'option-button--selected' : ''",
  'bindtap="goPrevious"',
  'bindtap="goNext"',
  "isLastQuestion ? '提交量表' : '下一题'",
  '{{result.total_score}}',
  '{{resultRiskLabel}}',
  '{{result.summary}}',
  'wx:for="{{result.recommendations}}"',
  '本量表结果仅用于辅助筛查，不替代专业医生诊断'
]

for (const fragment of requiredWxml) {
  assert.equal(
    wxml.includes(fragment),
    true,
    `WXML 缺少：${fragment}`
  )
}

const requiredSelectors = [
  '.scale-page',
  '.scale-card',
  '.scale-progress-value',
  '.question-text',
  '.option-button',
  '.option-button--selected',
  '.navigation-button',
  '.unsupported-card',
  '.result-card',
  '.medical-tip'
]

for (const selector of requiredSelectors) {
  assert.equal(
    wxss.includes(selector),
    true,
    `WXSS 缺少：${selector}`
  )
}

console.log('ASRS 页面视图结构测试全部通过')
