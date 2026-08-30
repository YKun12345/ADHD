const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const readJson = (...parts) => JSON.parse(read(...parts))

const pages = ['login', 'register', 'home']
const forbiddenLowContrastColors = [
  '#8aa0a8',
  '#71878f',
  '#6d838c',
  '#72878f',
  '#667d86',
  '#318ca6',
  '#8ba0a8'
]

for (const page of pages) {
  const json = readJson('pages', page, 'index.json')
  const wxss = read('pages', page, 'index.wxss')

  assert.equal(
    json.usingComponents && json.usingComponents['ui-icon'],
    '/components/ui-icon/index',
    `${page} 必须注册 ui-icon`
  )
  assert.equal(wxss.includes(':active'), false, `${page} 不得使用 :active`)
  assert.equal(wxss.includes('[disabled]'), false, `${page} 不得使用属性选择器`)
  assert.equal(wxss.includes('backdrop-filter'), false, `${page} 不得使用 backdrop-filter`)
  assert.equal(wxss.includes('constant(safe-area-inset-bottom)'), true, `${page} 缺少 safe-area 常量回退`)
  assert.equal(wxss.includes('env(safe-area-inset-bottom)'), true, `${page} 缺少 safe-area 环境变量回退`)
  assert.equal(/font-size:\s*(?:[01]?\d|20)rpx/.test(wxss), false, `${page} 关键文字不得小于 21rpx`)
  for (const color of forbiddenLowContrastColors) {
    assert.equal(wxss.toLowerCase().includes(color), false, `${page} 不得使用低对比色 ${color}`)
  }
}

const loginJson = readJson('pages', 'login', 'index.json')
const loginWxml = read('pages', 'login', 'index.wxml')
const loginJs = read('pages', 'login', 'index.js')
assert.equal(loginJson.navigationStyle, 'custom', '登录页必须使用沉浸式自定义导航')
assert.match(loginWxml, /class="login-card glass-surface"/)
assert.match(loginWxml, /<form\s+class="login-card glass-surface"\s+bindsubmit="handleLogin">/)
assert.match(loginWxml, /<ui-icon\s+name="plan"\s+shape="orbit"/)
assert.match(loginWxml, /class="field-input ui-input"/)
assert.match(loginWxml, /class="login-button ui-button ui-button--primary/)
assert.match(loginWxml, /hover-class="ui-button--pressed"/)
for (const input of loginWxml.match(/<input\b[^>]*\/>/g) || []) {
  assert.match(input, /\sdisabled="\{\{submitting\}\}"/, '登录输入必须在提交时冻结')
}
assert.match(loginWxml, /type="text"[\s\S]*?confirm-type="next"[\s\S]*?bindinput="onIdentifierInput"/)
assert.match(loginWxml, /password[\s\S]*?confirm-type="done"[\s\S]*?bindconfirm="handleLogin"/)
const loginButton = loginWxml.match(/<button\b[\s\S]*?<\/button>/)[0]
assert.match(loginButton, /form-type="submit"/)
assert.match(loginButton, /\sdisabled="\{\{submitting\}\}"/)
assert.doesNotMatch(loginButton, /bindtap="handleLogin"/)
assert.equal((loginWxml.match(/class="(?:login-tip|server-entry) entry-link \{\{submitting \? 'entry-link--disabled' : ''\}\}"/g) || []).length, 2)
assert.equal((loginWxml.match(/aria-disabled="\{\{submitting\}\}"/g) || []).length >= 2, true)
assert.doesNotMatch(loginWxml, /<text\b[^>]*hover-class=/, '登录页 hover 交互不能使用 text')
assert.doesNotMatch(loginWxml, /[\u{1F300}-\u{1FAFF}]/u, '登录页不得使用 emoji')
for (const method of ['onIdentifierInput', 'onPasswordInput']) {
  assert.match(
    loginJs,
    new RegExp(`${method}\\([^)]*\\)\\s*\\{\\s*if \\(this\\.data\\.submitting\\) return`),
    `登录提交期间 ${method} 必须冻结`
  )
}

const registerJson = readJson('pages', 'register', 'index.json')
const registerWxml = read('pages', 'register', 'index.wxml')
const registerJs = read('pages', 'register', 'index.js')
assert.equal(registerJson.navigationStyle, 'custom', '注册页必须使用沉浸式自定义导航')
assert.equal(registerJson.usingComponents['ui-nav'], '/components/ui-nav/index', '注册页必须注册 ui-nav')
assert.match(registerWxml, /^<ui-nav title="患者注册" fallbackUrl="\/pages\/login\/index" \/>/)
assert.match(registerWxml, /class="register-card glass-surface(?:\s[^"}]*)?"/)
assert.match(registerWxml, /<ui-icon\s+name="scale"\s+shape="sheet"/)
assert.equal(
  (registerWxml.match(/class="field-input ui-input"/g) || []).length,
  (registerWxml.match(/class="field-input(?: ui-input)?"/g) || []).length,
  '注册页所有 field-input 都必须接入 ui-input'
)
assert.match(registerWxml, /class="register-button ui-button ui-button--primary \{\{submitting \? 'ui-button--disabled' : ''\}\}"/)
assert.match(registerWxml, /hover-class="ui-button--pressed"/)
assert.match(registerWxml, /class="register-form \{\{submitting \? 'register-form--locked' : ''\}\}"/)
for (const input of registerWxml.match(/<input\b[\s\S]*?\/>/g) || []) {
  assert.match(input, /disabled="\{\{submitting\}\}"/, '注册页每个输入框都必须在提交时冻结')
}
assert.match(registerWxml, /<checkbox\b[\s\S]*?disabled="\{\{submitting\}\}"[\s\S]*?\/>/)
for (const option of registerWxml.match(/<view\b[^>]*bindtap="(?:onPatientTypeSelect|onGenderSelect)"[^>]*>/g) || []) {
  assert.match(option, /aria-role="radio"/, '选择项必须声明单选语义')
  assert.match(option, /aria-checked=/, '选择项必须声明选中状态')
}
assert.equal((registerWxml.match(/aria-role="radiogroup"/g) || []).length, 2, '患者类型和性别必须声明单选组语义')
for (const method of [
  'onFieldInput', 'onPatientTypeSelect', 'onGenderSelect',
  'togglePasswordVisibility', 'toggleConfirmPasswordVisibility',
  'onConsentChange', 'showConsentSummary'
]) {
  assert.match(
    registerJs,
    new RegExp(`${method}\\([^)]*\\)\\s*\\{\\s*if \\(this\\.data\\.submitting\\) return`),
    `注册提交期间 ${method} 必须冻结`
  )
}
assert.doesNotMatch(registerWxml, /<text\b[^>]*hover-class=/, '注册页 hover 交互不能使用 text')
assert.doesNotMatch(registerWxml, /[\u{1F300}-\u{1FAFF}]/u, '注册页不得使用 emoji')

const homeWxml = read('pages', 'home', 'index.wxml')
const homeJs = read('pages', 'home', 'index.js')
assert.match(homeWxml, /class="progress-card glass-surface"/)
assert.match(homeWxml, /class="task-list glass-surface"/)
assert.match(homeWxml, /<ui-icon\s+name="plan"\s+shape="orbit"/)
assert.match(homeWxml, /<ui-icon\s+name="\{\{item\.iconName\}\}"\s+shape="\{\{item\.iconShape\}\}"/)
assert.equal((homeWxml.match(/name="\{\{item\.iconName\}\}"/g) || []).length >= 2, true)
assert.equal((homeWxml.match(/aria-disabled="\{\{!item\.available\}\}"/g) || []).length, 2, '首页任务与入口必须标记不可用状态')
assert.equal((homeWxml.match(/hover-class="\{\{item\.available \? '[^']+--pressed' : 'none'\}\}"/g) || []).length, 2, '不可用入口必须取消按压态')
assert.doesNotMatch(homeWxml, /\{\{item\.icon\}\}/, '首页不得继续渲染文字假图标')
assert.doesNotMatch(homeWxml, /[\u{1F300}-\u{1FAFF}]/u, '首页不得使用 emoji')
for (const icon of ['scale', 'cognitive', 'report', 'tracking', 'education', 'ai']) {
  assert.match(homeJs, new RegExp(`\\b${icon}\\b`), `首页展示映射缺少 ${icon}`)
}
assert.match(homeJs, /MODULE_PRESENTATION/)
assert.match(homeJs, /function\s+decorateHomeItems/)
assert.match(homeJs, /tasks:\s*decorateHomeItems\(buildHomeTasks\(/)
assert.match(homeJs, /quickEntries:\s*decorateHomeItems\(buildQuickEntries\(/)
const homeWxss = read('pages', 'home', 'index.wxss')
const welcomeTextRule = homeWxss.match(/\.welcome-text\s*\{([^}]*)\}/)
assert.ok(welcomeTextRule, '首页缺少 welcome-text 样式')
assert.match(welcomeTextRule[1], /max-width:/)
assert.match(welcomeTextRule[1], /overflow:\s*hidden/)
assert.match(welcomeTextRule[1], /-webkit-line-clamp:\s*2/)

console.log('登录、注册、首页冰川玻璃视觉契约测试全部通过')
