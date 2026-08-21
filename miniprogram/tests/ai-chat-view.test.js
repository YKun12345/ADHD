const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pageDirectory = path.join(__dirname, '..', 'pages', 'ai-chat')
const wxml = fs.readFileSync(path.join(pageDirectory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(pageDirectory, 'index.wxss'), 'utf8')
const appConfig = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'app.json'),
  'utf8'
))

assert.equal(
  appConfig.pages.includes('pages/ai-chat/index'),
  true,
  'app.json 缺少 AI 助手页面路由'
)

const requiredWxml = [
  'AI健康助手',
  '{{patientName}}',
  'bindtap="goBack"',
  'bindtap="clearConversation"',
  'AI内容仅用于健康教育和追踪辅助',
  'wx:if="{{childNotice}}"',
  '建议由监护人陪同',
  'wx:for="{{contexts}}"',
  'context-tab--{{contextScope === item.id ? \'active\' : \'idle\'}}',
  'bindtap="selectScope"',
  'data-scope="{{item.id}}"',
  '<scroll-view',
  'scroll-y="true"',
  'scroll-into-view="{{scrollIntoView}}"',
  'wx:for="{{messages}}"',
  'message-row--{{item.role}}',
  '{{item.content}}',
  'wx:if="{{item.degraded}}"',
  '安全降级回答',
  'wx:if="{{item.usedContext.length}}"',
  'bindtap="retryMessage"',
  'data-id="{{item.id}}"',
  'wx:for="{{suggestions}}"',
  'bindtap="applySuggestion"',
  'bindinput="handleInput"',
  'bindconfirm="handleSend"',
  'maxlength="{{maxMessageLength}}"',
  'value="{{inputValue}}"',
  '{{inputLength}} / {{maxMessageLength}}',
  'bindtap="handleSend"',
  '正在生成回答',
  'id="chat-bottom"',
  '{{lastDisclaimer}}'
]

for (const fragment of requiredWxml) {
  assert.equal(
    wxml.includes(fragment),
    true,
    `WXML 缺少：${fragment}`
  )
}

assert.equal(wxml.includes('<rich-text'), false, 'AI 回答不得使用 rich-text 渲染')

const requiredSelectors = [
  '.chat-page',
  '.chat-nav',
  '.safety-banner',
  '.child-notice',
  '.context-tabs',
  '.context-tab--active',
  '.message-list',
  '.message-row--guide',
  '.message-row--user',
  '.message-row--assistant',
  '.message-bubble',
  '.degraded-badge',
  '.used-context',
  '.retry-button',
  '.suggestion-list',
  '.suggestion-item',
  '.composer',
  '.message-input',
  '.send-button',
  '.medical-disclaimer'
]

for (const selector of requiredSelectors) {
  assert.equal(
    wxss.includes(selector),
    true,
    `WXSS 缺少：${selector}`
  )
}

const sendButtonRule = wxss.match(/\.send-button\s*\{([^}]*)\}/)
assert.ok(sendButtonRule, 'WXSS 缺少 .send-button 样式规则')
assert.match(sendButtonRule[1], /display:\s*flex/)
assert.match(sendButtonRule[1], /align-items:\s*center/)
assert.match(sendButtonRule[1], /justify-content:\s*center/)

const retryButtonRule = wxss.match(/\.retry-button\s*\{([^}]*)\}/)
assert.ok(retryButtonRule, 'WXSS 缺少 .retry-button 样式规则')
assert.match(retryButtonRule[1], /display:\s*flex/)
assert.match(retryButtonRule[1], /align-items:\s*center/)
assert.match(retryButtonRule[1], /justify-content:\s*center/)

console.log('AI 助手页面视图结构测试全部通过')
