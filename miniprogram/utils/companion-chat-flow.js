const { request } = require('./request')
const { suggestedIntents, originalNote } = require('./companion-intent')
const transfer = require('./companion-transfer')
const dialogue = require('./companion-dialogue')
const positive = value => Number.isInteger(value) && value > 0
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const copy = value => JSON.parse(JSON.stringify(value))

function companionView(value, actions) {
  if (!value || value.protocol !== 'Xingzai-flow-1' || !hash(value.fingerprint) || typeof value.title !== 'string' ||
    typeof value.summary !== 'string' || typeof value.observation_context !== 'string' || !Array.isArray(value.updates) ||
    value.updates.some(row => !hash(row.id) || typeof row.text !== 'string')) return null
  const resumeId = positive(value.resume_action_id) && actions.some(row => row.id === value.resume_action_id) ? value.resume_action_id : null
  return { ...value, resume_action_id: resumeId }
}
const methods = {
  _restoreCompanionReturn() {
    if (!this._companionReturnId || this.data.inputValue.trim()) return false
    const id = this._companionReturnId; this._companionReturnId = ''
    const original = transfer.recover(id, this.data.patientId)
    if (!original) return false
    this.setData({ inputValue: original, businessChoices: suggestedIntents(original, this._role),
      statusText: '刚才的带入未完成，已恢复原话；请重新核对当前记录或接收关系。' }); return true
  },
  _clearCompanionInput() {
    this._preparedSmart = null; this._businessDraft = null; this._businessOptions = []
    this.setData({ smartPreview: null, selectedContextIds: [], businessChoices: [], businessOptions: [], businessDraft: null })
  },
  toggleContext(event) {
    if (!this.usable() || this.data.busy || this.data.pendingId || this.data.smartPreview) return false
    const id = Number(event.currentTarget.dataset.id)
    if (!this.data.contextChoices.some(row => row.run_id === id)) return false
    const ids = this.data.selectedContextIds.includes(id) ? this.data.selectedContextIds.filter(value => value !== id) : this.data.selectedContextIds.concat(id)
    if (ids.length > 2) { this.setData({ errorText: '一次最多选择两轮对话。' }); return false }
    this.setData({ selectedContextIds: ids, contextChoices: this.data.contextChoices.map(row => ({ ...row, selected: ids.includes(row.run_id) })), errorText: '' }); return true
  },
  cancelSmartPreview() {
    this._preparedSmart = null
    this.setData({ smartPreview: null, busy: false, statusText: '已取消，选中的对话尚未发送给模型。' })
  },
  async confirmSmartPreview() {
    const prepared = this._preparedSmart
    if (!prepared || !this.current(prepared.epoch) || this.data.busy || this.data.pendingId || prepared.message !== this.data.inputValue) return false
    this._preparedSmart = null; this.setData({ smartPreview: null, busy: true, errorText: '' })
    return this._submitPrepared(prepared)
  },
  _refreshContextChoices() {
    const choices = dialogue.contextChoices(this.data.runs)
    const selected = this.data.selectedContextIds.filter(id => choices.some(row => row.run_id === id))
    this.setData({ selectedContextIds: selected, contextChoices: choices.map(row => ({ ...row, selected: selected.includes(row.run_id) })) })
  },
  _showCompanion(value, epoch) {
    this.setData({ companion: value }, () => {
      if (!value || !this.current(epoch) || value.updates.length && this.data.hasRunning ||
        this._observedFingerprint === `${this.data.patientId}:${value.fingerprint}`) return
      const pid = this.data.patientId
      request({ url: '/agent/companion-observations', method: 'POST', data: { patient_id: this.data.patientId, observation_context: value.observation_context } })
        .then(result => { if (this.current(epoch) && result.observed === true && result.fingerprint === value.fingerprint) this._observedFingerprint = `${pid}:${value.fingerprint}` })
        .catch(() => {})
    })
  },
  async prepareBusiness(event) {
    if (!this.usable() || this.data.busy || this.data.loading || this.data.pendingId || this.data.smartPreview || !this.data.patientId) return false
    const kind = event.currentTarget.dataset.kind
    if (!suggestedIntents(this.data.inputValue, this._role).some(row => row.kind === kind)) return false
    if (['review_questions', 'plan_draft', 'reply_draft'].includes(kind)) {
      const intentIndex = this.data.intents.findIndex(row => row.value === kind)
      if (intentIndex < 0) return false
      this.setData({ intentIndex, isProfileInput: false, isCycleInput: false })
      return this._send(false)
    }
    const epoch = this._epoch = (this._epoch || 0) + 1, pid = this.data.patientId, original = this.data.inputValue
    this._businessDraft = null; this._businessOptions = []
    this.setData({ busy: true, businessDraft: null, businessOptions: [], errorText: '' })
    try {
      let options
      if (kind === 'daily') {
        if (this._role !== 'patient') return false
        const result = await request({ url: `/care/cycles?patient_id=${pid}` }); if (!this.current(epoch)) return false
        if (!Array.isArray(result.items) || result.items.some(row => row.patient_id !== pid || !positive(row.id))) throw new Error('日期周期来源不一致。')
        options = result.items.filter(row => row.processing_status === 'active').map(row => ({ id: row.id, kind, original,
          label: `${row.cycle_type === 'professional' ? '医生计划' : '自助记录'} · ${row.start_date} 至 ${row.end_date}` }))
      } else if (kind === 'message') {
        const result = await request({ url: `/care/shared-messages/relationships?patient_id=${pid}` }); if (!this.current(epoch)) return false
        if (!Array.isArray(result.items)) throw new Error('接收关系读取不完整。')
        options = result.items.filter(row => row.patient_id === pid && row.can_send === true && Array.isArray(row.scope) && row.scope.includes('care') &&
          positive(row.relationship_id) && positive(row.relationship_revision) && hash(row.send_context_digest) &&
          (this._role === 'researcher' ? row.doctor_user_id : row.patient_actor_user_id) === this._actor)
          .map(row => ({ id: row.relationship_id, kind, original, relation: row,
            label: `${this._role === 'researcher' ? '用户' : '医生'}账号 ${this._role === 'researcher' ? row.patient_actor_user_id : row.doctor_user_id} · 共享关系 ${row.relationship_id}` }))
      } else return false
      this._businessOptions = options
      this.setData({ busy: false, businessOptions: options.map(row => ({ id: row.id, label: row.label })),
        statusText: options.length ? '请选择实际的记录周期或接收关系。' : kind === 'daily' ? '还没有可记录的活动周期，请先在日期记录中建立周期。' : '当前没有可发送的照护共享关系，请先核对授权。' })
      if (options.length === 1) return this.chooseBusiness({ currentTarget: { dataset: { id: options[0].id } } })
      return true
    } catch (error) { if (this.current(epoch)) this.setData({ busy: false, errorText: error.message || '暂时无法准备，请稍后重试。' }); return false }
  },
  async chooseBusiness(event) {
    if (!this.usable() || this.data.busy || this.data.pendingId) return false
    const option = (this._businessOptions || []).find(row => row.id === Number(event.currentTarget.dataset.id))
    if (!option || option.original !== this.data.inputValue) return false
    const epoch = this._epoch = (this._epoch || 0) + 1, pid = this.data.patientId
    this.setData({ busy: true, errorText: '' })
    try {
      let draft
      if (option.kind === 'daily') {
        const cycle = await request({ url: `/care/cycles/${option.id}` }); if (!this.current(epoch)) return false
        const date = cycle.summary?.as_of_date
        if (cycle.id !== option.id || cycle.patient_id !== pid || cycle.processing_status !== 'active' || !cycle.allowed_actions?.includes('create_daily') ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < cycle.start_date || date > cycle.end_date || !Array.isArray(cycle.records)) throw new Error('这个周期当前不能记录今天，请到日期记录中核对。')
        const record = cycle.records.find(row => row.record_date === date), own = originalNote(option.original)
        const note = [record?.content?.note, own].filter(Boolean).join('\n')
        if (!note.trim() || note.length > 500) throw new Error('合并后的备注超过500字，请缩短本次文字后重试；原记录会保留。')
        draft = { kind: 'daily', binding: { kind: 'daily', patientId: pid, cycleId: cycle.id, recordDate: date,
          recordRevision: record?.revision || 0, cycleStatus: cycle.processing_status, planVersionId: cycle.plan_version_id ?? null },
          content: { note }, title: `记录 ${date}`, text: note, recipient: option.label,
          route: `/pages/care-cycles/index?patient_id=${pid}&cycle_id=${cycle.id}` }
      } else {
        if (!option.original.trim() || option.original.length > 2000) throw new Error('共享消息需在2000字以内，请缩短本次文字。')
        const row = option.relation
        draft = { kind: 'message', binding: { kind: 'message', patientId: pid, relationshipId: row.relationship_id,
          revision: row.relationship_revision, contextDigest: row.send_context_digest }, content: { content: option.original },
          title: '准备发给照护伙伴', text: option.original, recipient: option.label,
          route: `/pages/shared-messages/index?patient_id=${pid}&relationship_id=${row.relationship_id}` }
      }
      this._businessDraft = copy({ ...draft, original: option.original, epoch })
      this.setData({ busy: false, businessOptions: [], businessDraft: { title: draft.title, text: draft.text, recipient: draft.recipient }, statusText: '' }); return true
    } catch (error) { if (this.current(epoch)) this.setData({ busy: false, errorText: error.message }); return false }
  },
  confirmBusiness() {
    const draft = this._businessDraft
    if (!draft || !this.current(draft.epoch) || this.data.busy || this.data.pendingId || this.data.inputValue !== draft.original) return false
    const id = transfer.prepare(draft.binding, draft.content, draft.original)
    if (!id) return false
    this._companionReturnId = id
    this._businessDraft = null; this.setData({ businessDraft: null, businessOptions: [] })
    wx.navigateTo({ url: `${draft.route}&companion_transfer=${encodeURIComponent(id)}`, fail: () => transfer.discard(id) }); return true
  },
  cancelBusiness() { this._businessDraft = null; this._businessOptions = []; this.setData({ businessDraft: null, businessOptions: [], statusText: '已取消，尚未保存或发送。' }) },
  toggleQuietMotion() { if (this.usable()) this.setData({ reducedMotion: !this.data.reducedMotion }) }
}
module.exports = { methods, companionView }
