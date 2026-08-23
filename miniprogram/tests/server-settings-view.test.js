const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const pageDirectory = path.join(root, 'pages', 'server-settings')
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))

assert.equal(
  app.pages.includes('pages/server-settings/index'),
  true,
  'app.json 尚未登记服务器设置页'
)

for (const fileName of ['index.js', 'index.json', 'index.wxml', 'index.wxss']) {
  assert.equal(
    fs.existsSync(path.join(pageDirectory, fileName)),
    true,
    `服务器设置页缺少 ${fileName}`
  )
}

const wxml = fs.readFileSync(path.join(pageDirectory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(pageDirectory, 'index.wxss'), 'utf8')
const loginWxml = fs.readFileSync(path.join(root, 'pages', 'login', 'index.wxml'), 'utf8')
const homeWxml = fs.readFileSync(path.join(root, 'pages', 'home', 'index.wxml'), 'utf8')

for (const fragment of [
  'value="{{address}}"',
  'bindinput="onAddressInput"',
  'bindtap="testAndSave"',
  'bindtap="restoreDefault"',
  'loading="{{testing}}"',
  '{{environmentLabel}}',
  '{{statusMessage}}',
  '局域网 HTTP 仅用于开发调试',
  '正式发布必须使用 HTTPS 合法域名',
  '不会保存密码、token 或医疗资料'
]) {
  assert.equal(wxml.includes(fragment), true, `设置页 WXML 缺少：${fragment}`)
}

for (const selector of [
  '.settings-page',
  '.environment-card',
  '.address-input',
  '.test-button',
  '.reset-button',
  '.status-message--success',
  '.status-message--error'
]) {
  assert.equal(wxss.includes(selector), true, `设置页 WXSS 缺少：${selector}`)
}

assert.equal(loginWxml.includes('bindtap="openServerSettings"'), true)
assert.equal(loginWxml.includes('服务器连接设置'), true)
assert.equal(homeWxml.includes('bindtap="openServerSettings"'), true)
assert.equal(homeWxml.includes('服务器设置'), true)

console.log('服务器设置页面视图结构测试全部通过')
