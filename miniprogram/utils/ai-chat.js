const MAX_MESSAGE_LENGTH = 4000
const DEFAULT_DISCLAIMER = 'AI内容仅用于健康教育和追踪辅助，不能替代医生诊断或处方建议。'
const CHAT_CONTEXTS = Object.freeze([
  {
    id: 'general',
    label: '综合问答',
    description: '了解辅助筛查与日常安排'
  },
  {
    id: 'report',
    label: '报告解读',
    description: '结合已有报告理解结果'
  },
  {
    id: 'tracking',
    label: '追踪建议',
    description: '结合14天记录关注变化'
  }
])
const VALID_CONTEXT_SCOPES = new Set(
  CHAT_CONTEXTS.map((item) => item.id)
)
const VALID_CONVERSATION_ROLES = new Set(['user', 'assistant'])

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function validateChatMessage(value) {
  const message = cleanText(value)

  if (!message) {
    return {
      message: '',
      error: '请输入想咨询的内容'
    }
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return {
      message,
      error: `每条消息不能超过${MAX_MESSAGE_LENGTH}字`
    }
  }

  return {
    message,
    error: ''
  }
}

function normalizeContextScope(value) {
  return VALID_CONTEXT_SCOPES.has(value)
    ? value
    : 'general'
}

function buildConversation(messages, limit = 6) {
  if (!Array.isArray(messages)) return []

  const safeLimit = Number.isInteger(limit) && limit > 0
    ? limit
    : 6
  const conversation = messages
    .filter((item) => (
      item &&
      typeof item === 'object' &&
      VALID_CONVERSATION_ROLES.has(item.role) &&
      item.status === 'sent' &&
      cleanText(item.content)
    ))
    .map((item) => ({
      role: item.role,
      content: cleanText(item.content)
    }))

  return conversation.slice(-safeLimit)
}

function buildChatPayload({
  message,
  messages = [],
  contextScope = 'general'
} = {}) {
  const validation = validateChatMessage(message)
  if (validation.error) {
    throw new Error(validation.error)
  }

  return {
    message: validation.message,
    conversation: buildConversation(messages),
    context_scope: normalizeContextScope(contextScope)
  }
}

function normalizeUsedContext(value) {
  if (!Array.isArray(value)) return []

  return Array.from(new Set(
    value
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
  ))
}

function normalizeChatResponse(payload) {
  if (!payload || typeof payload !== 'object') return null

  const content = cleanText(payload.reply)
  if (!content) return null

  return {
    content,
    model: cleanText(payload.model),
    providerLabel: cleanText(payload.provider).toLowerCase() === 'qwen'
      ? '千问服务'
      : 'AI服务',
    disclaimer: cleanText(payload.disclaimer) || DEFAULT_DISCLAIMER,
    usedContext: normalizeUsedContext(payload.used_context),
    degraded: payload.degraded === true
  }
}

function createGuideMessage(patientType) {
  const childNotice = patientType === 'child'
    ? '儿童患者建议由监护人陪同使用。'
    : ''
  return {
    id: 'guide',
    role: 'guide',
    content: `你好，我可以帮助你理解量表、认知测试和追踪记录。${childNotice}请不要在对话中发送身份证号、联系方式等敏感信息。`,
    status: 'sent',
    degraded: false,
    usedContext: [],
    disclaimer: DEFAULT_DISCLAIMER
  }
}

function buildSuggestions(patientType) {
  const reportText = patientType === 'child'
    ? '请用适合家长理解的方式说明孩子的综合报告。'
    : '请用容易理解的方式说明我的综合报告。'
  const trackingText = patientType === 'child'
    ? '请帮我总结孩子最近的追踪记录，并提示可以关注的变化。'
    : '请帮我总结最近的追踪记录，并提示可以关注的变化。'

  return [
    {
      id: 'daily-plan',
      label: '日常安排',
      text: '我可以如何更好地安排每天的注意力任务？',
      scope: 'general'
    },
    {
      id: 'report-help',
      label: '理解报告',
      text: reportText,
      scope: 'report'
    },
    {
      id: 'tracking-help',
      label: '追踪变化',
      text: trackingText,
      scope: 'tracking'
    }
  ]
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  DEFAULT_DISCLAIMER,
  CHAT_CONTEXTS,
  validateChatMessage,
  normalizeContextScope,
  buildConversation,
  buildChatPayload,
  normalizeChatResponse,
  createGuideMessage,
  buildSuggestions
}
