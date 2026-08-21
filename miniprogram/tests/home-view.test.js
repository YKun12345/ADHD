const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pageDirectory = path.join(
  __dirname,
  '..',
  'pages',
  'home'
)
const wxml = fs.readFileSync(
  path.join(pageDirectory, 'index.wxml'),
  'utf8'
)
const wxss = fs.readFileSync(
  path.join(pageDirectory, 'index.wxss'),
  'utf8'
)

const requiredWxml = [
  "style=\"{{'width: ' + progressPercent + '%;'}}\"",
  '{{sourceLabel}}',
  '<view class="dashboard-source">',
  'wx:if="{{statusMessage}}"',
  '{{statusMessage}}',
  'data-id="{{item.id}}"',
  "item.available ? '' : 'task-item--disabled'",
  "item.available ? '' : 'quick-item--disabled'",
  '{{item.statusLabel}}',
  '本平台仅用于辅助筛查，不替代专业医生诊断'
]

for (const fragment of requiredWxml) {
  assert.equal(
    wxml.includes(fragment),
    true,
    `WXML 缺少：${fragment}`
  )
}

const requiredSelectors = [
  '.dashboard-source',
  '.dashboard-message',
  '.task-status',
  '.entry-status',
  '.task-item--disabled',
  '.quick-item--disabled'
]

for (const selector of requiredSelectors) {
  assert.equal(
    wxss.includes(selector),
    true,
    `WXSS 缺少：${selector}`
  )
}

const dashboardSourceRule = wxss.match(
  /\.dashboard-source\s*\{([^}]*)\}/
)
assert.ok(dashboardSourceRule, 'WXSS 缺少 .dashboard-source 样式规则')
assert.match(
  dashboardSourceRule[1],
  /display:\s*flex/,
  '“已同步”标签需要使用 flex 布局'
)
assert.match(
  dashboardSourceRule[1],
  /height:\s*40rpx/,
  '“已同步”标签需要固定高度'
)
assert.match(
  dashboardSourceRule[1],
  /align-items:\s*center/,
  '“已同步”文字需要垂直居中'
)
assert.match(
  dashboardSourceRule[1],
  /justify-content:\s*center/,
  '“已同步”文字需要水平居中'
)

console.log('患者首页视图结构测试全部通过')
