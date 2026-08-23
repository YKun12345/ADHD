const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pageDirectory = path.join(
  __dirname,
  '..',
  'pages',
  'privacy-settings'
)
const wxmlPath = path.join(pageDirectory, 'index.wxml')
const wxssPath = path.join(pageDirectory, 'index.wxss')

for (const filePath of [wxmlPath, wxssPath]) {
  assert.equal(
    fs.existsSync(filePath),
    true,
    `账号与隐私页缺少 ${path.basename(filePath)}`
  )
}

const wxml = fs.readFileSync(wxmlPath, 'utf8')
const wxss = fs.readFileSync(wxssPath, 'utf8')

for (const fragment of [
  '{{patientName}}',
  '{{draftCount}}',
  '{{resultCount}}',
  '{{trackingDayCount}}',
  '{{pendingCount}}',
  '{{totalLocalItems}}',
  'wx:if="{{pendingCount > 0}}"',
  'bindtap="clearLocalData"',
  'bindtap="logout"',
  'bindtap="goBack"',
  '清除本地数据不会删除服务器已保存数据',
  '清除和退出都会再次确认',
  '本平台仅用于辅助筛查，不替代专业医生诊断',
  '返回上一页'
]) {
  assert.equal(
    wxml.includes(fragment),
    true,
    `账号与隐私页 WXML 缺少：${fragment}`
  )
}

for (const action of ['clearLocalData', 'logout']) {
  const button = wxml.match(
    new RegExp(`<button[^>]*bindtap=["']${action}["'][^>]*>`, 's')
  )
  assert.ok(button, `账号与隐私页缺少 ${action} 按钮`)
  assert.match(
    button[0],
    /disabled=["']\{\{acting\}\}["']/,
    `${action} 按钮需要在操作期间禁用`
  )
}

const orderedSections = [
  'privacy-header',
  'summary-card',
  'pending-warning',
  'privacy-card',
  'danger-card',
  'medical-disclaimer',
  'back-link'
]
let previousSectionIndex = -1
for (const className of orderedSections) {
  const sectionIndex = wxml.indexOf(`class="${className}`)
  assert.ok(sectionIndex > previousSectionIndex, `${className} 的页面顺序不正确`)
  previousSectionIndex = sectionIndex
}

for (const selector of [
  '.summary-grid',
  '.summary-item',
  '.pending-warning',
  '.danger-card',
  '.clear-button',
  '.logout-button',
  '.back-link'
]) {
  assert.equal(
    wxss.includes(selector),
    true,
    `账号与隐私页 WXSS 缺少：${selector}`
  )
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ruleBodyFor(selector) {
  const match = wxss.match(
    new RegExp(`(?:^|})\\s*[^{}]*${escapeRegExp(selector)}[^{}]*\\{([^}]*)\\}`, 'm')
  )
  assert.ok(match, `WXSS 缺少 ${selector} 样式规则`)
  return match[1]
}

for (const selector of ['.clear-button', '.logout-button', '.back-link']) {
  const ruleBody = ruleBodyFor(selector)
  assert.match(ruleBody, /display:\s*flex/, `${selector} 需要使用 flex 布局`)
  assert.match(ruleBody, /align-items:\s*center/, `${selector} 内容需要垂直居中`)
  assert.match(
    ruleBody,
    /justify-content:\s*center/,
    `${selector} 内容需要水平居中`
  )
}

const pageRule = ruleBodyFor('page')
assert.match(pageRule, /background:\s*#f4f7fa/i, '页面背景色不正确')

const cardRule = ruleBodyFor('.summary-card')
assert.match(cardRule, /padding:\s*32rpx/, '卡片内边距需要为 32rpx')
assert.match(cardRule, /border-radius:\s*26rpx/, '卡片圆角需要为 26rpx')
assert.match(cardRule, /background:\s*#fff(?:fff)?/i, '卡片需要使用白色背景')
assert.match(cardRule, /box-shadow:/, '卡片需要使用轻阴影')

const summaryGridRule = ruleBodyFor('.summary-grid')
assert.match(summaryGridRule, /display:\s*flex/)
assert.match(summaryGridRule, /flex-wrap:\s*wrap/)
assert.match(summaryGridRule, /justify-content:\s*space-between/)
assert.match(ruleBodyFor('.summary-item'), /width:\s*48%/)

const warningRule = ruleBodyFor('.pending-warning')
assert.match(warningRule, /background:\s*#fff8e9/i, '待同步警示背景色不正确')
assert.match(warningRule, /color:\s*#7a5b2b/i, '待同步警示文字色不正确')

const clearRule = ruleBodyFor('.clear-button')
assert.match(clearRule, /color:\s*#b54747/i, 'clear button needs restrained red text')
assert.match(
  clearRule,
  /border:\s*[^;]*#b54747/i,
  'clear button needs a restrained red outline'
)
assert.match(clearRule, /background:\s*#fff(?:fff)?/i, 'clear button needs a white background')

const logoutRule = ruleBodyFor('.logout-button')
assert.match(logoutRule, /color:\s*#b54747/i, '退出按钮需要使用红色文字')
assert.match(
  logoutRule,
  /border:\s*[^;]*#b54747/i,
  '退出按钮需要使用红色描边'
)
assert.match(logoutRule, /background:\s*#fff(?:fff)?/i, '退出按钮需要使用白色背景')

assert.match(
  ruleBodyFor('.clear-button::after'),
  /border:\s*none/,
  '清除按钮需要移除 button 默认边框'
)
assert.match(
  wxss,
  /(?:\.clear-button|\.logout-button):disabled[^{}]*\{[^}]*opacity:\s*0?\.\d+/s,
  '危险操作按钮禁用时需要降低透明度'
)

console.log('账号与隐私页视图结构测试全部通过')
