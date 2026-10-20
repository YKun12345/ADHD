const { request } = require('./request')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('./session-privacy')
const queue = require('./submission-queue')
const positive = value => Number.isInteger(Number(value)) && Number(value) > 0
const plusDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)
const confirm = content => new Promise(resolve => wx.showModal({ title: '核对计划', content, success: result => resolve(result.confirm === true), fail: () => resolve(false) }))
const idFor = type => `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 13)}`
const LABELS = { active: '正在执行', suspended: '已暂停', ended: '已结束', pending: '待记录', completed: '已有实际记录',
  overdue: '尚未记录，已过日期', superseded_future: '未来安排已被新版替代' }
const blank = () => ({ plan: null, versions: [], tasks: [], records: [], title: '', instructions: '', startDate: '', endDate: '',
  canPublish: false, canReceive: false, pendingId: '', adoptionId: 0, errorText: '', statusText: '' })
module.exports = role => ({
  assistantDraftKey: role === 'researcher' ? 'doctor-plan' : '',
  data: { ...blank(), role, patientId: 0, assessmentId: 0, loading: false, busy: false },
  onLoad(options = {}) {
    this._active = true; this._lease = capturePatientSessionLease(); this._actor = (wx.getStorageSync('current_user') || {}).id
    this._adoptId = positive(options.ai_decision_id) ? Number(options.ai_decision_id) : 0
    this._invalid = !positive(options.patient_id) || !positive(options.assessment_id)
    this.setData({ patientId: this._invalid ? 0 : Number(options.patient_id), assessmentId: this._invalid ? 0 : Number(options.assessment_id) })
    return this.reload()
  },
  onShow() { if (this._ended) return false; this._active = true; return this.reload() },
  onHide() { this._active = false; this._epoch = (this._epoch || 0) + 1; this._context = null; this._adoption = null; this.setData({ ...blank(), loading: false, busy: false }) },
  onUnload() { this._ended = true; this.onHide() },
  _usable() { const actor = wx.getStorageSync('current_user') || {}; const ok = !this._ended && this._active && actor.id === this._actor &&
    actor.role === role && isPatientSessionLeaseCurrent(this._lease)
    if (!ok && this._active) { this._ended = true; this.onHide() } return ok },
  _current(epoch) { return this._usable() && this._epoch === epoch },
  _check(row) { if (!row || row.patient_id !== this.data.patientId || row.assessment_id !== this.data.assessmentId) throw new Error('计划与当前档案或评估不一致。'); return row },
  _pending() { const row = queue.pendingEntries().find(item => ['plan_publication', 'plan_received'].includes(item.kind) && item.payload.assessment_id === this.data.assessmentId)
    this.setData({ pendingId: row ? row.id : '' }) },
  async reload() {
    if (!this._usable() || this.data.busy || this.data.loading) return false
    if (this._invalid) { this.setData({ errorText: '请从当前档案的具体评估进入计划。' }); return false }
    const epoch = this._epoch = (this._epoch || 0) + 1; this._context = null; this._adoption = null; this.setData({ ...blank(), loading: true }); this._pending()
    try {
      const list = await request({ url: `/care/plans?patient_id=${this.data.patientId}` }); if (!this._current(epoch)) return false
      if (!Array.isArray(list.items)) throw new Error('计划列表不完整。')
      const plan = list.items.find(row => row.assessment_id === this.data.assessmentId)
      if (plan) {
        this._check(plan)
        const versions = plan.versions.map(row => this._check(row)), latest = versions[versions.length - 1]
        const received = (plan.acknowledgements || []).some(row => row.actor_user_id === this._actor && latest && row.plan_version_id === latest.id)
        this.setData({ plan: { ...plan, statusLabel: LABELS[plan.status] || '待核对' }, versions,
          tasks: (plan.tasks || []).map(row => ({ ...row, statusLabel: LABELS[row.status] || '待核对' })),
          canReceive: role === 'patient' && plan.status === 'active' && !received && !!latest })
      }
      if (role === 'researcher') {
        const ctx = this._check(await request({ url: `/care/assessments/${this.data.assessmentId}/plan-context` })); if (!this._current(epoch)) return false
        if (ctx.actor_user_id !== this._actor || !/^\d{4}-\d{2}-\d{2}$/.test(ctx.calendar_today)) throw new Error('计划发布核对不完整。')
        this._context = ctx
        const latest = plan && plan.versions[plan.versions.length - 1], start = plusDays(ctx.calendar_today, latest ? 1 : 0)
        this.setData({ canPublish: true, title: latest ? latest.title : '', instructions: latest ? latest.instructions : '', startDate: start,
          endDate: latest && latest.end_date >= start ? latest.end_date : plusDays(start, 13) })
        if (this._adoptId && !this.data.pendingId) {
          const adopted = await request({ url: `/agent/artifact-decisions/${this._adoptId}/adoption-context` }); if (!this._current(epoch)) return false
          if (adopted.id !== this._adoptId || adopted.actor_user_id !== this._actor || adopted.patient_id !== this.data.patientId ||
            adopted.assessment_id !== this.data.assessmentId || adopted.target_type !== 'plan_publication' || adopted.content.source_report_id !== ctx.source_report_id) throw new Error('已核对计划草稿与当前已发布意见不一致。')
          this._adoption = adopted; this.setData({ adoptionId: adopted.id, title: adopted.content.title, instructions: adopted.content.instructions })
        }
      }
      this.setData({ loading: false }); return true
    } catch (failure) { if (this._current(epoch)) this.setData({ loading: false, canPublish: false, errorText: failure.message || '计划读取失败。' }); return false }
  },
  onTextInput(event) { const field = event.currentTarget.dataset.field
    if (this._usable() && !this.data.busy && !this.data.pendingId && !this.data.adoptionId && ['title', 'instructions'].includes(field)) this.setData({ [field]: event.detail.value }) },
  onDateInput(event) { const field = event.currentTarget.dataset.field
    if (this._usable() && !this.data.busy && !this.data.pendingId && ['startDate', 'endDate'].includes(field)) this.setData({ [field]: event.detail.value }) },
  async publish() {
    if (!this._usable() || role !== 'researcher' || this.data.busy || this.data.pendingId || !this._context || !this.data.canPublish) return false
    if (!this.data.title.trim() || !this.data.instructions.trim()) { this.setData({ errorText: '请填写本人确认的实际计划和记录说明。' }); return false }
    const ctx = this._context, id = this._adoption ? this._adoption.target_client_id : idFor('plan')
    const payload = { client_plan_version_id: id, patient_id: this.data.patientId, assessment_id: this.data.assessmentId,
      expected_assessment_version: ctx.assessment_version, expected_previous_version: ctx.expected_previous_version,
      expected_plan_revision: ctx.expected_plan_revision, source_report_id: ctx.source_report_id, input_digest: ctx.input_digest,
      plan_context: ctx.plan_context, title: this.data.title, instructions: this.data.instructions,
      start_date: this.data.startDate, end_date: this.data.endDate,
      ...(this._adoption ? { source_ai_decision_id: this._adoption.id } : {}), confirmed: true }
    return this._submit('plan_publication', id, '/care/plan-versions', ctx.plan_context_digest, payload,
      `确认发布第 ${ctx.expected_previous_version + 1} 版计划：${payload.title}，${payload.start_date} 至 ${payload.end_date}。每天建立一项实际记录任务。修订只改变未来安排。`)
  },
  async receive() {
    if (!this._usable() || role !== 'patient' || this.data.busy || this.data.pendingId || !this.data.canReceive) return false
    const latest = this.data.versions[this.data.versions.length - 1], epoch = this._epoch = (this._epoch || 0) + 1
    this.setData({ busy: true, errorText: '' })
    try {
      const ctx = this._check(await request({ url: `/care/plan-versions/${latest.id}/acknowledgement-context` })); if (!this._current(epoch)) return false
      if (ctx.actor_user_id !== this._actor || ctx.plan_version_id !== latest.id || ctx.plan_payload_digest !== latest.payload_digest || ctx.version !== latest.version) throw new Error('计划版本已变化，请重新读取。')
      this.setData({ busy: false }); const id = idFor('received')
      return this._submit('plan_received', id, '/care/plan-acknowledgements', ctx.acknowledgement_context_digest, {
        client_acknowledgement_id: id, patient_id: this.data.patientId, assessment_id: this.data.assessmentId,
        plan_version_id: latest.id, acknowledgement_context: ctx.acknowledgement_context, confirmed: true },
      `确认已收到并读到第 ${latest.version} 版计划。这个记录只表示收到，不代表已经执行或确认治疗效果。`)
    } catch (failure) { if (this._current(epoch)) this.setData({ busy: false, errorText: failure.message || '收到确认尚未保存。' }); return false }
  },
  async _submit(kind, id, route, digest, payload, message) {
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, errorText: '', statusText: '' })
    try {
      const agreed = await confirm(message); if (!this._current(epoch)) return false
      if (!agreed) { this.setData({ busy: false }); return false }
      queue.enqueue({ id, kind, route, expected_context_digest: digest, payload }); this._pending()
      const ack = await queue.syncQueuedAcknowledgement(id); if (!this._current(epoch)) return false
      this.setData({ busy: false }); this._pending()
      if (!ack) { this.setData({ statusText: '已保留本机原件，尚未取得服务器确认。请按原编号查询，不要重复创建。' }); return false }
      this._adoptId = 0; this._adoption = null
      await this.reload(); return true
    } catch (failure) { if (this._current(epoch)) this.setData({ busy: false, errorText: failure.message || '保存未完成，请保留内容重试。' }); return false }
  },
  async queryPending() {
    if (!this._usable() || this.data.busy || !this.data.pendingId) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true })
    const ack = await queue.queryQueuedStatus(this.data.pendingId); if (!this._current(epoch)) return false
    this.setData({ busy: false }); this._pending(); if (ack) { this._adoptId = 0; this._adoption = null; await this.reload() } return Boolean(ack)
  },
  async openCycle(event) {
    if (!this._usable() || this.data.busy) return false
    const id = Number(event.currentTarget.dataset.id); if (!this.data.versions.some(row => row.cycle_id === id)) return false
    if (role === 'patient') { wx.navigateTo({ url: `/pages/care-cycles/index?patient_id=${this.data.patientId}&cycle_id=${id}` }); return true }
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, records: [] })
    try { const cycle = await request({ url: `/care/cycles/${id}` }); if (!this._current(epoch)) return false
      if (cycle.id !== id || cycle.patient_id !== this.data.patientId || !Array.isArray(cycle.records)) throw new Error('周期记录归属不一致。')
      this.setData({ busy: false, records: cycle.records.map(row => ({ ...row, actualText: JSON.stringify(row.content) })) }); return true
    } catch (failure) { if (this._current(epoch)) this.setData({ busy: false, errorText: failure.message || '周期记录读取失败。' }); return false }
  },
  openStageReview(event) { if (!this._usable() || this.data.busy) return false
    const id = Number(event.currentTarget.dataset.id); if (!this.data.versions.some(row => row.cycle_id === id)) return false
    wx.navigateTo({ url: `/pages/cycle-review/index?patient_id=${this.data.patientId}&cycle_id=${id}` }); return true },
  openRecovery() { if (this._usable()) wx.navigateTo({ url: '/pages/submission-queue/index' }) }
})
