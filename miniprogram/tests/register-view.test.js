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
  (wxml.match(/class="register-card"/g) || []).length,
  2,
  '注册页必须恰好包含患者信息和账号安全两个卡片'
)
assert.equal(
  wxml.includes('注册表单将在下一步填写'),
  false,
  '必须删除占位文案'
)

console.log('注册页面结构测试全部通过')
