const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

for (const page of ['patient-messages', 'patient-tasks']) {
  const dir = path.join(__dirname, '..', 'pages', page)
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    assert.equal(fs.existsSync(path.join(dir, `index.${ext}`)), true, `${page} 缺少 ${ext}`)
  }
  const js = fs.readFileSync(path.join(dir, 'index.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(dir, 'index.wxml'), 'utf8')
  assert.match(js, /registerPatientPage\(\{/)
  assert.match(wxml, /<ai-copilot/)
  assert.match(wxml, /辅助筛查|紧急情况/)
}

const messages = fs.readFileSync(path.join(__dirname, '..', 'pages', 'patient-messages', 'index.wxml'), 'utf8')
const messagesController = fs.readFileSync(path.join(__dirname, '..', 'pages', 'patient-messages', 'index.js'), 'utf8')
assert.match(messages, /bindtap="retryMessage"/)
assert.match(messagesController, /client_message_id:\s*stableClientMessageId/)
assert.match(messagesController, /message\.clientMessageId/)
assert.match(messages, /发送失败/)
assert.match(messages, /bindfocus="onInputFocus"/)
assert.match(messages, /bindblur="onInputBlur"/)
const tasks = fs.readFileSync(path.join(__dirname, '..', 'pages', 'patient-tasks', 'index.wxml'), 'utf8')
assert.match(tasks, /医生安排/)
assert.match(tasks, /bindtap="openTask"/)

console.log('患者消息与任务页面结构测试全部通过')
