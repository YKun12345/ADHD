const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const registerDirectory = path.join(
  __dirname,
  '..',
  'pages',
  'register'
)
const wxml = fs.readFileSync(
  path.join(registerDirectory, 'index.wxml'),
  'utf8'
)
const wxss = fs.readFileSync(
  path.join(registerDirectory, 'index.wxss'),
  'utf8'
)

const requiredWxmlSnippets = [
  'bindsubmit="handleSubmit"',
  'data-field="fullName"',
  'data-field="age"',
  'type="number"',
  'data-value="adult"',
  'data-value="child"',
  'data-value="male"',
  'data-value="female"',
  'data-value="other"',
  'data-value="undisclosed"',
  'data-field="email"',
  'data-field="password"',
  'data-field="confirmPassword"',
  'password="{{!showPassword}}"',
  'password="{{!showConfirmPassword}}"',
  'bindchange="onConsentChange"',
  'bindtap="showConsentSummary"',
  'loading="{{submitting}}"',
  'disabled="{{submitting}}"',
  'ui-button--disabled',
  'bindtap="goBackToLogin"',
  '本平台仅用于辅助筛查，不替代专业医生诊断'
]

for (const snippet of requiredWxmlSnippets) {
  assert.equal(
    wxml.includes(snippet),
    true,
    `WXML 缺少：${snippet}`
  )
}

assert.equal(
  (wxml.match(/class="register-card\s[^"']*"/g) || []).length,
  2,
  '注册页必须恰好包含患者信息和账号安全两个卡片'
)
assert.equal(
  wxml.includes('注册表单将在下一步填写'),
  false,
  '必须删除占位文案'
)

const requiredWxssSnippets = [
  '.register-page',
  'min-height: 100vh',
  '.register-card',
  '.choice-card--active',
  '.gender-option--active',
  '.password-control',
  '.consent-panel',
  'constant(safe-area-inset-bottom)',
  'env(safe-area-inset-bottom)',
  '#173f50',
  '#236b80'
]

for (const snippet of requiredWxssSnippets) {
  assert.equal(
    wxss.includes(snippet),
    true,
    `WXSS 缺少：${snippet}`
  )
}

assert.equal(
  /position\s*:\s*fixed/.test(wxss),
  false,
  '注册表单不能用 fixed 定位锁死页面滚动'
)

const registerButtonRule = wxss.match(
  /\.register-button\s*\{([\s\S]*?)\}/
)
assert.ok(registerButtonRule, 'WXSS 缺少注册按钮规则')
assert.match(registerButtonRule[1], /display:\s*flex/)
assert.match(registerButtonRule[1], /align-items:\s*center/)
assert.match(registerButtonRule[1], /justify-content:\s*center/)
assert.doesNotMatch(registerButtonRule[1], /line-height:\s*92rpx/)

console.log('注册页面结构测试全部通过')
