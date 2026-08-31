const assert = require('node:assert/strict')

const {
  COPILOT_PAGE_KEYS,
  getCopilotConfig,
  buildAiChatUrl
} = require('../utils/ai-copilot')
const {
  normalizeInitialPrompt
} = require('../utils/ai-chat')

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
  const promptParameter = url.split('prompt=')[1]
  assert.equal(normalizeInitialPrompt(promptParameter), config.helpPrompt)
  assert.equal(
    normalizeInitialPrompt(decodeURIComponent(promptParameter)),
    config.helpPrompt
  )
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
assert.match(buildAiChatUrl('scale', 'help'), /copilot-v1%3A/)

console.log('AI Copilot 页面配置测试全部通过')
