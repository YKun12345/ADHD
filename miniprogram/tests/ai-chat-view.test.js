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
  '<ui-nav title="AI 健康助手" rightText="清空" bind:righttap="clearConversation" />',
  'class="chat-notice"',
  '{{lastDisclaimer}}',
  'wx:if="{{childNotice}}"',
  '建议由监护人陪同',
  'class="chat-workspace"',
  'wx:for="{{contexts}}"',
  'context-pill--{{contextScope === item.id ? \'active\' : \'idle\'}}',
  'bindtap="selectScope"',
  'data-scope="{{item.id}}"',
  '<scroll-view',
  'scroll-y="true"',
  'scroll-into-view="{{scrollIntoView}}"',
  'wx:for="{{messages}}"',
  'message-row--{{item.role}}',
  '{{item.content}}',
  'wx:if="{{item.degraded}}"',
  '本地辅助回答',
  'wx:if="{{item.usedContext.length}}"',
  'bindtap="retryMessage"',
  'data-id="{{item.id}}"',
  'wx:for="{{suggestions}}"',
  'class="quick-prompts"',
  'bindtap="applySuggestion"',
  'class="composer__main"',
  'bindinput="handleInput"',
  'bindconfirm="handleSend"',
  '可以询问健康问题或小程序使用方法',
  'maxlength="{{maxMessageLength}}"',
  'value="{{inputValue}}"',
  'wx:if="{{showInputCount}}"',
  '{{inputLength}}/{{maxMessageLength}}',
  'bindtap="handleSend"',
  '正在生成回答',
  'id="chat-bottom"'
]

for (const fragment of requiredWxml) {
  assert.equal(
    wxml.includes(fragment),
    true,
    `WXML 缺少：${fragment}`
  )
}

assert.equal(wxml.includes('<rich-text'), false, 'AI 回答不得使用 rich-text 渲染')

for (const removedFragment of [
  'class="safety-banner"',
  'class="context-section"',
  'class="suggestion-section"',
  'class="medical-disclaimer"',
  'class="composer__disclaimer"',
  'message-avatar--user'
]) {
  assert.equal(wxml.includes(removedFragment), false, `WXML 不应保留旧结构：${removedFragment}`)
}

assert.equal((wxml.match(/\{\{lastDisclaimer\}\}/g) || []).length, 1, '安全说明只应显示一次')

const requiredSelectors = [
  '.chat-page',
  '.chat-notice',
  '.chat-workspace',
  '.context-tools',
  '.context-pill--active',
  '.message-list',
  '.message-row--guide',
  '.message-row--user',
  '.message-row--assistant',
  '.message-bubble',
  '.degraded-badge',
  '.used-context',
  '.retry-button',
  '.quick-prompts',
  '.quick-prompt',
  '.composer',
  '.composer__main',
  '.message-input',
  '.send-button'
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

const messageListRule = wxss.match(/\.message-list\s*\{([^}]*)\}/)
assert.ok(messageListRule, 'WXSS 缺少 .message-list 样式规则')
assert.match(messageListRule[1], /background:\s*transparent/)
assert.doesNotMatch(messageListRule[1], /border:/)
assert.doesNotMatch(messageListRule[1], /box-shadow:/)

const retryButtonRule = wxss.match(/\.retry-button\s*\{([^}]*)\}/)
assert.ok(retryButtonRule, 'WXSS 缺少 .retry-button 样式规则')
assert.match(retryButtonRule[1], /display:\s*flex/)
assert.match(retryButtonRule[1], /align-items:\s*center/)
assert.match(retryButtonRule[1], /justify-content:\s*center/)

console.log('AI 助手页面视图结构测试全部通过')
