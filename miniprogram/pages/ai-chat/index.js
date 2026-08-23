const { registerPatientPage } = require('../../utils/patient-page')
const { request } = require('../../utils/request')
const {
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
} = require('../../utils/session-privacy')
const {
  MAX_MESSAGE_LENGTH,
  DEFAULT_DISCLAIMER,
  CHAT_CONTEXTS,
  validateChatMessage,
  normalizeContextScope,
  buildChatPayload,
  normalizeChatResponse,
  createGuideMessage,
  buildSuggestions
} = require('../../utils/ai-chat')

function patientTypeFromUser(user) {
  const profile = user && typeof user === 'object'
    ? user.patient_profile
    : null
  const patientType = profile && typeof profile === 'object'
    ? String(profile.patient_type || '').toLowerCase()
    : ''
  return patientType === 'adult' || patientType === 'child'
    ? patientType
    : ''
}

registerPatientPage({
  data: {
    patientName: '患者',
    patientType: '',
    childNotice: false,
    contexts: CHAT_CONTEXTS,
    contextScope: 'general',
    messages: [createGuideMessage('')],
    suggestions: buildSuggestions(''),
    inputValue: '',
    inputLength: 0,
    maxMessageLength: MAX_MESSAGE_LENGTH,
    sending: false,
    statusMessage: '',
    scrollIntoView: '',
    lastDisclaimer: DEFAULT_DISCLAIMER
  },

  onLoad(options = {}) {
    const user = wx.getStorageSync('current_user')
    const patientType = patientTypeFromUser(user)
    const patientName = user && typeof user.full_name === 'string' && user.full_name.trim()
      ? user.full_name.trim()
      : '患者'

    this._active = true
    this._messageSequence = 0
    this.setData({
      patientName,
      patientType,
      childNotice: patientType === 'child',
      contextScope: normalizeContextScope(options.scope),
      messages: [createGuideMessage(patientType)],
      suggestions: buildSuggestions(patientType),
      inputValue: '',
      inputLength: 0,
      sending: false,
      statusMessage: '',
      scrollIntoView: '',
      lastDisclaimer: DEFAULT_DISCLAIMER
    })
  },

  onUnload() {
    this._active = false
  },

  onPatientSessionEnded() {
    this._active = false
  },

  _nextMessageId(prefix) {
    this._messageSequence = (this._messageSequence || 0) + 1
    return `${prefix}-${this._messageSequence}`
  },

  _scrollToBottom() {
    wx.nextTick(() => {
      if (!this._active) return
      this.setData({
        scrollIntoView: 'chat-bottom'
      })
    })
  },

  handleInput(event) {
    const value = event && event.detail && typeof event.detail.value === 'string'
      ? event.detail.value
      : ''
    this.setData({
      inputValue: value,
      inputLength: value.length
    })
  },

  selectScope(event) {
    const scope = event && event.currentTarget
      ? event.currentTarget.dataset.scope
      : ''
    if (normalizeContextScope(scope) !== scope) return
    this.setData({ contextScope: scope })
  },

  applySuggestion(event) {
    const suggestionId = event && event.currentTarget
      ? event.currentTarget.dataset.id
      : ''
    const suggestion = this.data.suggestions.find(
      (item) => item.id === suggestionId
    )
    if (!suggestion) return

    this.setData({
      inputValue: suggestion.text,
      inputLength: suggestion.text.length,
      contextScope: suggestion.scope
    })
  },

  handleSend() {
    return this._sendMessage(this.data.inputValue)
  },

  retryMessage(event) {
    const messageId = event && event.currentTarget
      ? event.currentTarget.dataset.id
      : ''
    const message = this.data.messages.find((item) => (
      item.id === messageId &&
      item.role === 'user' &&
      item.status === 'failed'
    ))
    if (!message) return
    return this._sendMessage(message.content, message.id)
  },

  async _sendMessage(rawMessage, retryMessageId = '') {
    if (this.data.sending) return

    const validation = validateChatMessage(rawMessage)
    if (validation.error) {
      wx.showToast({
        title: validation.error,
        icon: 'none'
      })
      return
    }

    const payload = buildChatPayload({
      message: validation.message,
      messages: this.data.messages,
      contextScope: this.data.contextScope
    })
    const messageId = retryMessageId || this._nextMessageId('user')
    let messages

    if (retryMessageId) {
      messages = this.data.messages.map((item) => (
        item.id === retryMessageId
          ? { ...item, status: 'sending' }
          : item
      ))
    } else {
      messages = [
        ...this.data.messages,
        {
          id: messageId,
          role: 'user',
          content: validation.message,
          status: 'sending',
          degraded: false,
          usedContext: [],
          disclaimer: ''
        }
      ]
    }

    this.setData({
      messages,
      inputValue: '',
      inputLength: 0,
      sending: true,
      statusMessage: ''
    })
    this._scrollToBottom()

    const lease = capturePatientSessionLease()

    try {
      const response = await request({
        url: '/ai/chat',
        method: 'POST',
        data: payload
      })
      if (!isPatientSessionLeaseCurrent(lease)) return
      const assistant = normalizeChatResponse(response)
      if (!assistant) {
        throw new Error('服务返回内容不完整，请稍后重试')
      }
      if (!this._active) return

      const completedMessages = this.data.messages.map((item) => (
        item.id === messageId
          ? { ...item, status: 'sent' }
          : item
      ))
      completedMessages.push({
        id: this._nextMessageId('assistant'),
        role: 'assistant',
        status: 'sent',
        ...assistant
      })
      this.setData({
        messages: completedMessages,
        sending: false,
        statusMessage: '',
        lastDisclaimer: assistant.disclaimer
      })
      this._scrollToBottom()
    } catch (error) {
      if (!this._active || !isPatientSessionLeaseCurrent(lease)) return

      this.setData({
        messages: this.data.messages.map((item) => (
          item.id === messageId
            ? { ...item, status: 'failed' }
            : item
        )),
        sending: false,
        statusMessage: error && error.message
          ? error.message
          : '暂时无法发送，请稍后重试'
      })
      this._scrollToBottom()
    }
  },

  clearConversation() {
    if (this.data.sending) {
      wx.showToast({
        title: '请等待当前消息发送完成',
        icon: 'none'
      })
      return
    }

    wx.showModal({
      title: '清空本次对话',
      content: '只清空当前页面中的消息，不影响服务端已有记录。',
      confirmText: '清空',
      success: (result) => {
        if (!result.confirm || !this._active) return
        this._messageSequence = 0
        this.setData({
          messages: [createGuideMessage(this.data.patientType)],
          inputValue: '',
          inputLength: 0,
          statusMessage: '',
          scrollIntoView: '',
          lastDisclaimer: DEFAULT_DISCLAIMER
        })
      }
    })
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})
