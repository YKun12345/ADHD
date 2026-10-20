const { request } = require('../../utils/request')
const { protectPatientPage } = require('../../utils/patient-page')
const { hasValidAnySession } = require('../../utils/role-session')
const { ensurePatientSession, capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const queue = require('../../utils/submission-queue')

const positive = value => Number.isInteger(value) && value > 0
const queryId = value => /^\d+$/.test(String(value)) && positive(Number(value))
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const instant = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
const clone = value => JSON.parse(JSON.stringify(value))
const fail = text => Object.assign(new Error(text), { pageMessage: true })
const displayTime = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + '（北京时间）'
const newId = () => `message-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
function errorText(error) {
  if (error && (error.pageMessage || /^QUEUE_/.test(error.code || ''))) return error.message
  return error && error.statusCode === 403 ? '当前身份或原共享授权不可用，请核对关系后重试。' : '消息资料读取失败或不一致，请重试。'
}
function pendingText(item) {
  if (item.status === 'authorization_blocked') return '原共享授权已失效，这份原件仍保存在本机；可核对服务器是否已确认。'
  if (item.status === 'conflict_blocked' || item.status === 'ack_unverified') return '这份原件尚未获得一致的服务器确认，请核对服务器记录。'
  return '这份已确认的原件已保存在本机，尚未获得服务器确认。重试会使用原内容和原接收关系。'
}

Page(protectPatientPage({
  assistantDraftKey: 'shared-messages',
  data: { role: 'patient', fallbackUrl: '/pages/home/index', patients: [], patientId: 0, patientIndex: -1, patientLabel: '请选择档案',
    relationships: [], relationshipId: 0, relationshipIndex: -1, relationshipLabel: '请选择接收关系', messages: [], content: '',
    canSend: false, pendingId: '', pendingStatus: '', adoptionId: 0, loading: false, busy: false, errorText: '', statusText: '' },
  async onLoad(options = {}) {
    this._active = true
    this._pageLease = capturePatientSessionLease()
    this._companionTransferId = typeof options.companion_transfer === 'string' ? options.companion_transfer : ''
    const user = wx.getStorageSync('current_user') || {}
    this._owner = { id: user.id, role: user.role }
    this._adoptId = queryId(options.ai_decision_id) ? Number(options.ai_decision_id) : 0
    this._invalid = (options.patient_id !== undefined && !queryId(options.patient_id)) ||
      (options.relationship_id !== undefined && (!queryId(options.relationship_id) || !queryId(options.patient_id)))
    this._preferredPatientId = queryId(options.patient_id) ? Number(options.patient_id) : 0
    this._preferredRelationshipId = queryId(options.relationship_id) ? Number(options.relationship_id) : 0
    this.setData({ role: user.role, fallbackUrl: user.role === 'researcher' ? '/pages/doctor-home/index' : '/pages/home/index' })
    const loaded = await this.reload()
    if (loaded) this._applyCompanionTransfer()
    return loaded
  },
  onShow() {
    if (this._ended) return false
    this._active = true
    if (!this._usable()) return false
    return this.reload()
  },
  onHide() {
    if (this._companionTransferId) require('../../utils/companion-transfer').discard(this._companionTransferId)
    this._companionTransferId = ''
    this._active = false
    this._version = (this._version || 0) + 1
    this._relations = []; this._relation = null; this._adoption = null
    this.setData({ patients: [], patientId: 0, patientIndex: -1, patientLabel: '请选择档案', relationships: [], relationshipId: 0,
      relationshipIndex: -1, relationshipLabel: '请选择接收关系', messages: [], content: '', canSend: false, pendingId: '', pendingStatus: '',
      adoptionId: 0, loading: false, busy: false, errorText: '', statusText: '' })
  },
  onUnload() { this._ended = true; this.onHide() },
  onPatientSessionEnded() { this._ended = true; this._preferredPatientId = 0; this._preferredRelationshipId = 0; this.onHide() },
  _applyCompanionTransfer() {
    const id = this._companionTransferId; this._companionTransferId = ''
    if (!id) return false
    const relation = this._relation
    const value = require('../../utils/companion-transfer').consume(id, { kind: 'message', patientId: this.data.patientId,
      relationshipId: relation?.relationship_id, revision: relation?.relationship_revision, contextDigest: relation?.send_context_digest })
    if (!value || !this.data.canSend || this.data.pendingId || this.data.adoptionId) {
      this.setData({ statusText: '准备内容已失效或原接收关系有变化，请回星仔重新核对。' }); return false
    }
    const applied = this.applyAssistantInput({ content: value.content, statusText: '已带入你确认的原话，尚未发送；请核对接收关系和内容。' })
    if (applied) require('../../utils/companion-transfer').complete(id)
    return applied
  },
  _usable() {
    if (this._ended || !this._active) return false
    let user
    try { user = wx.getStorageSync('current_user') } catch (_) { user = null }
    if (!hasValidAnySession() || !isPatientSessionLeaseCurrent(this._pageLease) || !user || !this._owner ||
      user.id !== this._owner.id || user.role !== this._owner.role) { this.onPatientSessionEnded(); return false }
    return true
  },
  _current(lease, version) { return this._usable() && this._version === version && isPatientSessionLeaseCurrent(lease) },
  _begin(patch) {
    this._version = (this._version || 0) + 1
    this.setData({ errorText: '', statusText: '', ...patch })
    return { lease: capturePatientSessionLease(), version: this._version }
  },
  async reload() {
    if (!this._usable() || this.data.loading || this.data.busy) return false
    const draft = this.data.content, previousRelationshipId = this.data.relationshipId
    const { lease, version } = this._begin({ loading: true, messages: [], relationships: [], canSend: false })
    this._relations = []; this._relation = null
    try {
      if (this._invalid) throw fail('档案或接收关系编号无效，请从当前账号的档案重新进入。')
      const doctor = this._owner.role === 'researcher'
      const response = await request({ url: doctor ? '/doctor/my_patients' : '/identity/context' })
      if (!this._current(lease, version)) return false
      const source = doctor ? response && response.items : response && response.accessible_patients
      if (!Array.isArray(source) || source.some(row => !row || !positive(row.patient_id)) || new Set(source.map(row => row.patient_id)).size !== source.length) throw fail('档案范围不一致，请重新读取。')
      const patients = source.map(row => ({ patient_id: row.patient_id,
        label: `${doctor ? row.patient_name || '' : row.display_name || ''}${doctor ? row.patient_name ? ' · ' : '' : row.display_name ? ' · ' : ''}档案 ${row.patient_id}` }))
      let patientId = this._preferredPatientId
      if (!patientId && !doctor && patients.length === 1) patientId = patients[0].patient_id
      const index = patients.findIndex(row => row.patient_id === patientId)
      this.setData({ patients, patientId: 0, patientIndex: -1, patientLabel: '请选择档案', relationshipId: 0,
        relationshipIndex: -1, relationshipLabel: '请选择接收关系', content: '', pendingId: '', pendingStatus: '' })
      if (patientId && index < 0) throw fail('该档案不在当前账号的实际可用范围内。')
      if (!patientId) { this.setData({ loading: false }); return true }
      this._preferredPatientId = patientId
      this.setData({ patientId, patientIndex: index, patientLabel: patients[index].label })
      await this._loadRelationships(lease, version, previousRelationshipId === this._preferredRelationshipId ? draft : '')
      if (!this._current(lease, version)) return false
      await this._loadAdoption(lease,version); if (!this._current(lease,version)) return false
      this.setData({ loading: false }); return true
    } catch (error) {
      if (this._current(lease, version)) {
        this._relations = []; this._relation = null
        this.setData({ loading: false, relationships: [], messages: [], content: '', canSend: false, pendingId: '', pendingStatus: '', errorText: errorText(error) })
      }
      return false
    }
  },
  async _loadRelationships(lease, version, draft = '') {
    const patientId = this.data.patientId
    const response = await request({ url: `/care/shared-messages/relationships?patient_id=${patientId}` })
    if (!this._current(lease, version)) return false
    if (!response || !Array.isArray(response.items)) throw fail('共享关系资料不一致，请重试。')
    const doctor = this._owner.role === 'researcher'
    const rows = response.items
    if (new Set(rows.map(row => row && row.relationship_id)).size !== rows.length || rows.some(row => !row || row.patient_id !== patientId ||
      !positive(row.relationship_id) || !positive(row.relationship_revision) || !positive(row.doctor_user_id) || !positive(row.patient_actor_user_id) ||
      !Array.isArray(row.scope) || !row.scope.includes('care') || typeof row.can_send !== 'boolean' ||
      (doctor && row.doctor_user_id !== this._owner.id) || (row.can_send && !doctor && row.patient_actor_user_id !== this._owner.id) ||
      (row.can_send ? typeof row.send_context !== 'string' || !row.send_context || !digest(row.send_context_digest) : row.send_context !== null || row.send_context_digest !== null))) throw fail('共享关系归属或发送凭据不一致，请重新核对。')
    this._relations = clone(rows)
    const relationships = rows.map(row => ({ relationship_id: row.relationship_id, can_send: row.can_send,
      label: `${doctor ? '用户账号 ' + row.patient_actor_user_id : '医生账号 ' + row.doctor_user_id} · 关系 ${row.relationship_id}${row.can_send ? '' : ' · 仅查看历史'}` }))
    this.setData({ relationships })
    const index = relationships.findIndex(row => row.relationship_id === this._preferredRelationshipId)
    if (index < 0) {
      if (this._preferredRelationshipId) throw fail('这条提醒对应的接收关系当前不可用，请重新核对共享关系。')
      return true
    }
    this._selectRelation(index)
    await this._loadMessages(lease, version)
    if (!this._current(lease, version)) return false
    this._restorePending(draft)
    return true
  },
  _selectRelation(index) {
    this._relation = this._relations[index]
    this._preferredRelationshipId = this._relation.relationship_id
    this.setData({ relationshipId: this._relation.relationship_id, relationshipIndex: index,
      relationshipLabel: this.data.relationships[index].label, canSend: this._relation.can_send, messages: [], content: '', pendingId: '', pendingStatus: '' })
  },
  _restorePending(draft = '') {
    const item = queue.pendingEntries().find(row => row.kind === 'shared_message' && row.payload.patient_id === this.data.patientId && row.payload.relationship_id === this.data.relationshipId)
    this.setData({ pendingId: item ? item.id : '', pendingStatus: item ? item.status : '', content: item ? item.payload.content : draft,
      statusText: item ? pendingText(item) : '' })
    return item
  },
  async selectPatient(event) {
    if (!this._usable() || this.data.loading || this.data.busy || this._adoptId) return false
    const index = Number(event.detail.value), row = this.data.patients[index]
    if (!Number.isInteger(index) || !row) return false
    this._preferredPatientId = row.patient_id; this._preferredRelationshipId = 0
    this.setData({ patientId: row.patient_id, relationshipId: 0, content: '', pendingId: '', pendingStatus: '' })
    return this.reload()
  },
  async selectRelationship(event) {
    if (!this._usable() || this.data.loading || this.data.busy) return false
    const index = Number(event.detail.value)
    if (!Number.isInteger(index) || !this._relations[index]) return false
    const { lease, version } = this._begin({ loading: true })
    this._selectRelation(index)
    try {
      await this._loadMessages(lease, version)
      if (!this._current(lease, version)) return false
      this._restorePending(); await this._loadAdoption(lease,version); if (!this._current(lease,version)) return false
      this.setData({ loading: false }); return true
    } catch (error) {
      if (this._current(lease, version)) this.setData({ loading: false, messages: [], canSend: false, errorText: errorText(error) })
      return false
    }
  },
  async _loadMessages(lease, version) {
    const patientId = this.data.patientId, relation = this._relation
    const response = await request({ url: `/care/shared-messages?patient_id=${patientId}&relationship_id=${relation.relationship_id}` })
    if (!this._current(lease, version)) return false
    if (!response || !Array.isArray(response.items)) throw fail('消息资料不一致，请重新核对。')
    const ids = new Set()
    const messages = response.items.map(row => {
      if (!row || !positive(row.message_id) || ids.has(row.message_id) || row.patient_id !== patientId || row.relationship_id !== relation.relationship_id ||
        !positive(row.relationship_revision) || row.doctor_user_id !== relation.doctor_user_id || row.patient_actor_user_id !== relation.patient_actor_user_id ||
        !['patient', 'doctor'].includes(row.sender_kind) || row.sender_user_id !== (row.sender_kind === 'doctor' ? row.doctor_user_id : row.patient_actor_user_id) ||
        typeof row.client_message_id !== 'string' || !row.client_message_id || typeof row.sender_identity_basis !== 'string' || !row.sender_identity_basis ||
        typeof row.content !== 'string' || !row.content.trim() || row.content.length > 2000 || row.confirmed !== true || row.version !== 1 || row.legacy !== false ||
        row.submission_status !== 'committed' || !instant(row.sent_at) || !digest(row.content_digest) || !digest(row.context_digest) || !digest(row.send_context_digest) ||
        !Array.isArray(row.read_receipts)) throw fail('消息来源或接收关系不一致，请重新核对。')
      ids.add(row.message_id)
      const viewers = new Set()
      for (const receipt of row.read_receipts) {
        if (!receipt || receipt.message_id !== row.message_id || !positive(receipt.viewer_user_id) || viewers.has(receipt.viewer_user_id) || !instant(receipt.read_at)) throw fail('查看记录不一致，请重新核对。')
        viewers.add(receipt.viewer_user_id)
      }
      const mine = row.read_receipts.find(receipt => receipt.viewer_user_id === this._owner.id)
      if (row.viewer_read_at !== (mine ? mine.read_at : null)) throw fail('当前账号的查看记录不一致，请重新核对。')
      return { message_id: row.message_id, client_message_id: row.client_message_id, patient_id: row.patient_id, relationship_id: row.relationship_id,
        sender_user_id: row.sender_user_id, sender_kind: row.sender_kind, content: row.content, sent_at: row.sent_at,
        timeLabel: displayTime(row.sent_at), senderLabel: `${row.sender_kind === 'doctor' ? '医生' : '用户'}账号 ${row.sender_user_id}${row.sender_user_id === this._owner.id ? '（我）' : ''}`,
        viewer_read_at: row.viewer_read_at, readLabel: mine ? '我已查看' : '我尚未确认查看' }
    })
    this.setData({ messages }); return true
  },
  async _loadAdoption(lease,version) {
    if (!this._adoptId || this.data.pendingId) return true
    const adopted = await request({ url: `/agent/artifact-decisions/${this._adoptId}/adoption-context` })
    if (!this._current(lease,version)) return false
    if (adopted.id !== this._adoptId || adopted.actor_user_id !== this._owner.id || adopted.patient_id !== this.data.patientId ||
      adopted.target_type !== 'shared_message' || this._owner.role !== 'researcher') throw fail('已核对回复与当前档案或发送者不一致。')
    this._adoption = adopted; this.setData({ adoptionId: adopted.id, content: adopted.content.text }); return true
  },
  onContentInput(event) {
    if (this._usable() && !this.data.loading && !this.data.busy && !this.data.pendingId && !this.data.adoptionId && this.data.canSend) this.setData({ content: event.detail.value, statusText: '', errorText: '' })
  },
  async sendMessage() {
    if (!this._usable() || this.data.loading || this.data.busy || !this._relation || (!this.data.canSend && !this.data.pendingId)) return false
    const { lease, version } = this._begin({ busy: true })
    try {
      let id = this.data.pendingId
      const pending = queue.pendingEntries()
      let original = pending.find(row => (!id || row.id === id) && row.kind === 'shared_message' && row.payload.patient_id === this.data.patientId && row.payload.relationship_id === this.data.relationshipId)
      if (id && !original) {
        this.setData({ busy: false, content: '', pendingId: '', pendingStatus: '' })
        await this.reload()
        return false
      }
      if (original) {
        id = original.id
        this.setData({ pendingId: id, pendingStatus: original.status, content: original.payload.content })
      }
      if (original && ['authorization_blocked', 'conflict_blocked'].includes(original.status)) {
        this.setData({ busy: false, statusText: pendingText(original) }); return false
      }
      if (!original) {
        const content = this.data.content
        if (typeof content !== 'string' || !content.trim() || content.length > 2000) throw fail('请填写1至2000字的消息，并核对接收关系。')
        id = this._adoption ? this._adoption.target_client_id : newId()
        original = queue.enqueue({ id, kind: 'shared_message', route: '/care/shared-messages',
          expected_context_digest: this._relation.send_context_digest, expected_relationship_revision: this._relation.relationship_revision,
          payload: { patient_id: this.data.patientId, relationship_id: this._relation.relationship_id, client_message_id: id, content,
            send_context: this._relation.send_context, confirmed: true, reply_to_message_id: null,
            ...(this._adoption ? { source_ai_decision_id: this._adoption.id } : {}) } })
        const durable = queue.pendingEntries().find(row => row.id === id)
        if (!durable || durable.fingerprint !== original.fingerprint) throw fail('消息原件保存未完成，请保留当前内容并重试。')
        this.setData({ pendingId: id, pendingStatus: original.status })
      }
      const ack = await queue.syncQueuedAcknowledgement(id)
      if (!this._current(lease, version)) return false
      this.setData({ busy: false })
      if (!ack) {
        const pending = this._restorePending()
        if (!pending) { await this.reload(); return false }
        return false
      }
      this._adoptId = 0; this._adoption = null; this.setData({ content: '', pendingId: '', pendingStatus: '', adoptionId: 0 })
      const loaded = await this.reload()
      if (loaded && this._usable()) this.setData({ statusText: '服务器已确认这条消息。' })
      return loaded
    } catch (error) {
      if (this._current(lease, version)) {
        try { this._restorePending(this.data.content) } catch (_) {}
        this.setData({ busy: false, errorText: errorText(error) })
      }
      return false
    }
  },
  async queryPending() {
    if (!this._usable() || this.data.loading || this.data.busy || !this.data.pendingId) return false
    const id = this.data.pendingId, { lease, version } = this._begin({ busy: true })
    try {
      const recovered = await queue.queryQueuedStatus(id)
      if (!this._current(lease, version)) return false
      if (recovered) { this._adoptId = 0; this._adoption = null }
      this.setData({ busy: false, content: '', pendingId: '', pendingStatus: '', adoptionId: 0 })
      return this.reload()
    } catch (error) {
      if (this._current(lease, version)) this.setData({ busy: false, errorText: errorText(error) })
      return false
    }
  },
  openLegacy() {
    if (!this._usable() || this.data.loading || this.data.busy || this._owner.role !== 'patient') return false
    wx.navigateTo({ url: '/pages/patient-messages/index' }); return true
  },
  async markRead(event) {
    if (!this._usable() || this.data.loading || this.data.busy) return false
    const id = Number(event.currentTarget.dataset.id), row = this.data.messages.find(item => item.message_id === id)
    if (!row || row.viewer_read_at) return false
    const { lease, version } = this._begin({ busy: true })
    try {
      const receipt = await request({ url: `/care/shared-messages/${id}/read`, method: 'POST' })
      if (!this._current(lease, version)) return false
      if (!receipt || receipt.message_id !== id || receipt.viewer_user_id !== this._owner.id || !instant(receipt.read_at)) throw fail('当前账号的查看回执不一致，请重新核对。')
      await this._loadMessages(lease, version)
      if (!this._current(lease, version)) return false
      this.setData({ busy: false, statusText: '已记录当前账号查看；查看不代表专业处理或事项解决。' }); return true
    } catch (error) {
      if (this._current(lease, version)) this.setData({ busy: false, errorText: errorText(error) })
      return false
    }
  }
}, options => hasValidAnySession() || ensurePatientSession(options)))
