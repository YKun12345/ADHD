const assert = require('node:assert/strict')

const {
  COPILOT_PAGE_KEYS,
  getCopilotConfig,
  buildAiChatUrl
} = require('../utils/ai-copilot')

const expectedKeys = [
  'home',
  'scale',
  'cognitive-center',
  'cognitive',
  'stroop',
  'tracking',
  'tracking-trend',
  'report',
  'care-pathway',
  'education',
  'education-detail'
]

assert.deepEqual(COPILOT_PAGE_KEYS, expectedKeys)

for (const pageKey of expectedKeys) {
  const config = getCopilotConfig(pageKey)
  assert.equal(config.pageKey, pageKey)
  assert.equal(Boolean(config.title), true)
  assert.equal(Boolean(config.advice), true)
  assert.equal(Boolean(config.helpPrompt), true)
  assert.equal(config.helpPrompt.length <= 4000, true)

  const url = buildAiChatUrl(pageKey, 'help')
  assert.match(url, /^\/pages\/ai-chat\/index\?scope=general&prompt=/)
  assert.equal(decodeURIComponent(url.split('prompt=')[1]), config.helpPrompt)
}

assert.equal(getCopilotConfig('unknown').pageKey, 'general')
assert.equal(
  buildAiChatUrl('home', 'free'),
  '/pages/ai-chat/index?scope=general'
)
assert.equal(
  buildAiChatUrl('home', 'invalid'),
  '/pages/ai-chat/index?scope=general'
)
assert.match(buildAiChatUrl('scale', 'help'), /%E8%AF%B7/)

console.log('AI Copilot 页面配置测试全部通过')
