const { registerPatientPage } = require('../../utils/patient-page')
const { request } = require('../../utils/request')
const { normalizePatientMessages } = require('../../utils/patient-care')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')

registerPatientPage({
  data: { messages: [], input: '', inputFocused: false, loading: false, sending: false, errorText: '' },
  onLoad() { this._hasCurrentSession() },
  onShow() { this._hidden = false; return this.loadMessages() },
  _clearHistory() {
    this._loadVersion = (this._loadVersion || 0) + 1
    this._draftClientMessageId = ''
    this.setData({ messages: [], input: '', inputFocused: false, loading: false, sending: false, errorText: '' })
  },
  _hasCurrentSession() {
    let user
    try { user = wx.getStorageSync('current_user') } catch (_) { user = null }
    if (!this._entryLease) {
      this._entryLease = capturePatientSessionLease()
      this._entryActorId = user && user.id
    }
    const valid = !this._hidden && !this._ended && user && user.role === 'patient' &&
      Number.isInteger(user.id) && user.id > 0 && user.id === this._entryActorId && isPatientSessionLeaseCurrent(this._entryLease)
    if (!valid) this._clearHistory()
    return Boolean(valid)
  },
  onHide() { this._hidden = true; this._clearHistory() },
  onUnload() { this._ended = true; this._clearHistory() },
  onPatientSessionEnded() { this._ended = true; this._clearHistory() },
  async loadMessages() {
    if (!this._hasCurrentSession() || this.data.loading) return
    const version = (this._loadVersion || 0) + 1
    this._loadVersion = version
    this.setData({ loading: true, errorText: '' })
    try {
      // Legacy history is only the authenticated person's history, never current relationship evidence.
      const payload = await request({ url: '/care/patient/messages' })
      if (!this._hasCurrentSession() || this._loadVersion !== version) return
      this.setData({ loading: false, messages: normalizePatientMessages(payload, this._entryActorId) })
    } catch (error) {
      if (!this._hasCurrentSession() || this._loadVersion !== version) return
      this.setData({ loading: false, errorText: error.message || '历史消息加载失败' })
    }
  },
  openSharedMessages() {
    if (!this._hasCurrentSession()) return
    wx.navigateTo({ url: '/pages/shared-messages/index' })
  },
  // Retained callable names cannot send or retry the retired unscoped protocol.
  sendMessage() { return this.openSharedMessages() },
  _sendContent() { return this.openSharedMessages() },
  retryMessage() { return this.openSharedMessages() },
  retryLoad() { return this.loadMessages() }
})
