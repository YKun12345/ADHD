const { registerPatientPage } = require('../../utils/patient-page')
const { request } = require('../../utils/request')
const { normalizePatientMessages, validateCareMessage, createClientMessageId } = require('../../utils/patient-care')

registerPatientPage({
  data: { messages: [], input: '', inputFocused: false, loading: false, sending: false, errorText: '' },
  onShow() { return this.loadMessages() },
  onUnload() { this._loadVersion = (this._loadVersion || 0) + 1 },
  async loadMessages() {
    if (this.data.loading) return
    const version = (this._loadVersion || 0) + 1
    this._loadVersion = version
    this.setData({ loading: true, errorText: '' })
    try {
      const payload = await request({ url: '/care/patient/messages' })
      if (this._loadVersion !== version) return
      this.setData({ loading: false, messages: normalizePatientMessages(payload) })
      request({ url: '/care/patient/messages/read', method: 'POST' }).catch(() => {})
    } catch (error) {
      if (this._loadVersion !== version) return
      this.setData({ loading: false, errorText: error.message || '消息加载失败' })
    }
  },
  onInput(event) {
    if (this.data.sending) return
    const input = event.detail.value
    if (input !== this.data.input) this._draftClientMessageId = ''
    this.setData({ input })
  },
  onInputFocus() { this.setData({ inputFocused: true }) },
  onInputBlur() { this.setData({ inputFocused: false }) },
  async sendMessage() {
    if (this.data.sending) return
    const validation = validateCareMessage(this.data.input)
    if (!validation.ok) return wx.showToast({ title: validation.message, icon: 'none' })
    const clientMessageId = this._draftClientMessageId || createClientMessageId()
    this._draftClientMessageId = clientMessageId
    return this._sendContent(validation.content, '', clientMessageId)
  },
  async _sendContent(content, failedId = '', clientMessageId = '') {
    const stableClientMessageId = clientMessageId || createClientMessageId()
    this.setData({ sending: true })
    try {
      const created = await request({
        url: '/care/patient/messages',
        method: 'POST',
        data: { content, client_message_id: stableClientMessageId }
      })
      const next = this.data.messages.filter((item) => item.id !== failedId).concat(normalizePatientMessages([created]))
      const updates = { sending: false, messages: next }
      if (this._draftClientMessageId === stableClientMessageId) {
        this._draftClientMessageId = ''
        updates.input = ''
      }
      this.setData(updates)
    } catch (error) {
      const id = failedId || `failed-${Date.now()}`
      const failed = { id, isMine: true, senderName: '我', content, clientMessageId: stableClientMessageId, createdAt: '刚刚', status: 'failed' }
      this.setData({ sending: false, messages: this.data.messages.filter((item) => item.id !== id).concat(failed) })
    }
  },
  retryMessage(event) {
    const id = event.currentTarget.dataset.id
    const message = this.data.messages.find((item) => item.id === id && item.status === 'failed')
    if (message) return this._sendContent(message.content, id, message.clientMessageId)
  },
  retryLoad() { return this.loadMessages() }
})
