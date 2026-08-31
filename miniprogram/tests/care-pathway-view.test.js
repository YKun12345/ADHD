const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const directory = path.join(__dirname, '..', 'pages', 'care-pathway')
const wxml = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8')

const requiredWxml = [
  '辅助筛查路径', '{{patientName}}', '{{sourceLabel}}',
  '{{completedCount}} / {{totalCount}}', '{{percent}}%',
  'pathway-progress__value--{{completedCount}}',
  'wx:if="{{currentStep}}"', '{{currentStep.title}}',
  'wx:for="{{steps}}"', 'pathway-step--{{item.status}}',
  '{{item.statusLabel}}', '{{item.detail}}',
  'bindtap="openStep"', 'data-step="{{item.id}}"',
  'bindtap="openAi"', 'bindtap="openEducation"',
  '专业评估、影像与医生结论不计入本页完成度',
  '仅用于辅助筛查，不替代专业医生诊断'
]
for (const fragment of requiredWxml) {
  assert.equal(wxml.includes(fragment), true, `WXML 缺少：${fragment}`)
}

const selectors = [
  '.pathway-page', '.pathway-summary', '.pathway-progress',
  '.pathway-progress__value--0', '.pathway-progress__value--1',
  '.pathway-progress__value--2', '.pathway-progress__value--3',
  '.pathway-progress__value--4', '.pathway-progress__value--5',
  '.current-step', '.pathway-timeline', '.pathway-step',
  '.pathway-step--done', '.pathway-step--partial', '.pathway-step--pending',
  '.step-action', '.support-grid', '.professional-note', '.medical-tip'
]
for (const selector of selectors) {
  assert.equal(wxss.includes(selector), true, `WXSS 缺少：${selector}`)
}
const actionRule = wxss.match(/\.step-action\s*\{([^}]*)\}/)
assert.ok(actionRule)
assert.match(actionRule[1], /display:\s*(?:inline-)?flex/)
assert.match(actionRule[1], /align-items:\s*center/)
assert.match(actionRule[1], /justify-content:\s*center/)

console.log('临床路径页面视图结构测试全部通过')
