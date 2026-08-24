const assert = require('node:assert/strict')

const {
  MAX_MESSAGE_LENGTH,
  DEFAULT_DISCLAIMER,
  CHAT_CONTEXTS,
  validateChatMessage,
  normalizeContextScope,
  normalizeInitialPrompt,
  buildConversation,
  buildChatPayload,
  normalizeChatResponse,
  createGuideMessage,
  buildSuggestions
} = require('../utils/ai-chat')

assert.equal(MAX_MESSAGE_LENGTH, 4000)
assert.equal(
  DEFAULT_DISCLAIMER,
  'AI内容仅用于健康教育和追踪辅助，不能替代医生诊断或处方建议。'
)
assert.deepEqual(
  CHAT_CONTEXTS.map((item) => item.id),
  ['general', 'report', 'tracking']
)
assert.equal(
  CHAT_CONTEXTS.every((item) => item.label && item.description),
  true
)

assert.deepEqual(validateChatMessage('  我想了解注意力记录  '), {
  message: '我想了解注意力记录',
  error: ''
})
assert.deepEqual(validateChatMessage(' \n\t '), {
  message: '',
  error: '请输入想咨询的内容'
})
assert.equal(
  validateChatMessage('问'.repeat(MAX_MESSAGE_LENGTH)).error,
  ''
)
assert.equal(
  validateChatMessage('问'.repeat(MAX_MESSAGE_LENGTH + 1)).error,
  '每条消息不能超过4000字'
)
assert.equal(validateChatMessage(null).message, '')

assert.equal(normalizeContextScope('general'), 'general')
assert.equal(normalizeContextScope('report'), 'report')
assert.equal(normalizeContextScope('tracking'), 'tracking')
assert.equal(normalizeContextScope('REPORT'), 'general')
assert.equal(normalizeContextScope('unknown'), 'general')
assert.equal(normalizeContextScope(null), 'general')

assert.equal(normalizeInitialPrompt(undefined), '')
assert.equal(normalizeInitialPrompt('请介绍首页'), '请介绍首页')
assert.equal(
  normalizeInitialPrompt(
    '%E8%AF%B7%E4%BB%8B%E7%BB%8D%E9%A6%96%E9%A1%B5'
  ),
  '请介绍首页'
)
assert.equal(normalizeInitialPrompt('%E0%A4%A'), '%E0%A4%A')
assert.equal(
  normalizeInitialPrompt('问'.repeat(4001)).length,
  4000
)

const history = [
  { role: 'guide', content: '本地欢迎引导', status: 'sent' },
  { role: 'user', content: ' 第1条 ', status: 'sent' },
  { role: 'assistant', content: '第2条', status: 'sent' },
  { role: 'user', content: '第3条', status: 'sent' },
  { role: 'assistant', content: '第4条', status: 'sent' },
  { role: 'user', content: '第5条', status: 'sent' },
  { role: 'assistant', content: '第6条', status: 'sent' },
  { role: 'user', content: '第7条', status: 'sent' },
  { role: 'assistant', content: '第8条', status: 'sent' },
  { role: 'user', content: '失败消息', status: 'failed' },
  { role: 'user', content: '发送中消息', status: 'sending' },
  { role: 'system', content: '非法角色', status: 'sent' },
  { role: 'assistant', content: '   ', status: 'sent' },
  null
]

assert.deepEqual(buildConversation(history), [
  { role: 'user', content: '第3条' },
  { role: 'assistant', content: '第4条' },
  { role: 'user', content: '第5条' },
  { role: 'assistant', content: '第6条' },
  { role: 'user', content: '第7条' },
  { role: 'assistant', content: '第8条' }
])
assert.deepEqual(buildConversation(history, 2), [
  { role: 'user', content: '第7条' },
  { role: 'assistant', content: '第8条' }
])
assert.deepEqual(buildConversation(null), [])

assert.deepEqual(
  buildChatPayload({
    message: '  请解释报告  ',
    messages: history,
    contextScope: 'report'
  }),
  {
    message: '请解释报告',
    conversation: [
      { role: 'user', content: '第3条' },
      { role: 'assistant', content: '第4条' },
      { role: 'user', content: '第5条' },
      { role: 'assistant', content: '第6条' },
      { role: 'user', content: '第7条' },
      { role: 'assistant', content: '第8条' }
    ],
    context_scope: 'report'
  }
)
assert.equal(
  buildChatPayload({ message: '问题', contextScope: 'bad' }).context_scope,
  'general'
)
assert.throws(
  () => buildChatPayload({ message: '   ' }),
  /请输入想咨询的内容/
)
assert.throws(
  () => buildChatPayload({ message: '问'.repeat(4001) }),
  /每条消息不能超过4000字/
)

assert.deepEqual(
  normalizeChatResponse({
    reply: '  建议先查看已完成的追踪记录。  ',
    model: 'qwen-plus-latest',
    provider: 'qwen',
    disclaimer: '  服务端安全提示  ',
    used_context: ['量表', '', '追踪', '量表', 123],
    degraded: true
  }),
  {
    content: '建议先查看已完成的追踪记录。',
    model: 'qwen-plus-latest',
    providerLabel: '千问服务',
    disclaimer: '服务端安全提示',
    usedContext: ['量表', '追踪'],
    degraded: true
  }
)
assert.deepEqual(
  normalizeChatResponse({
    reply: '普通回答',
    provider: 'unknown-provider'
  }),
  {
    content: '普通回答',
    model: '',
    providerLabel: 'AI服务',
    disclaimer: DEFAULT_DISCLAIMER,
    usedContext: [],
    degraded: false
  }
)
assert.equal(normalizeChatResponse(null), null)
assert.equal(normalizeChatResponse({}), null)
assert.equal(normalizeChatResponse({ reply: '  ' }), null)
assert.equal(normalizeChatResponse({ reply: 123 }), null)

const adultGuide = createGuideMessage('adult')
assert.equal(adultGuide.id, 'guide')
assert.equal(adultGuide.role, 'guide')
assert.equal(adultGuide.status, 'sent')
assert.match(adultGuide.content, /量表、认知测试和追踪记录/)
assert.doesNotMatch(adultGuide.content, /监护人陪同/)

const childGuide = createGuideMessage('child')
assert.equal(childGuide.role, 'guide')
assert.match(childGuide.content, /监护人陪同/)
assert.deepEqual(buildConversation([childGuide]), [])

const adultSuggestions = buildSuggestions('adult')
const childSuggestions = buildSuggestions('child')
assert.equal(adultSuggestions.length, 3)
assert.equal(childSuggestions.length, 3)
assert.deepEqual(
  adultSuggestions.map((item) => item.scope),
  ['general', 'report', 'tracking']
)
assert.equal(
  childSuggestions.some((item) => /孩子/.test(item.text)),
  true
)
for (const suggestion of [...adultSuggestions, ...childSuggestions]) {
  assert.equal(Boolean(suggestion.id && suggestion.label && suggestion.text), true)
  assert.equal(normalizeContextScope(suggestion.scope), suggestion.scope)
  assert.equal(validateChatMessage(suggestion.text).error, '')
}

console.log('AI 助手聊天数据测试全部通过')
