const { request } = require('../../utils/request')
const { protectPatientPage } = require('../../utils/patient-page')
const { hasValidAnySession } = require('../../utils/role-session')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const queue = require('../../utils/submission-queue')
const positive = value => Number.isInteger(Number(value)) && Number(value) > 0
const plusDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)
const LABELS = { continue: '继续，发布后续日期计划', adjust: '调整未来安排', end: '结束本计划或自助周期', next_round: '下一轮' }
const blank = () => ({ cycle: null, reviews: [], records: [], coverageText: '', canConfirm: false, decisions: [], decisionIndex: 0,
  body: '', limitations: '', reason: '', title: '', instructions: '', startDate: '', endDate: '', pendingId: '', errorText: '', statusText: '', loading: false, busy: false, adoptionId: 0 })
Page(protectPatientPage({
  assistantDraftKey: 'cycle-review',
  data: { ...blank(), role: '', patientId: 0, cycleId: 0, needsDates: false, needsPlan: false },
  onLoad(options = {}) {
    this._active = true; this._lease = capturePatientSessionLease(); const actor = wx.getStorageSync('current_user') || {}
    this._actor = actor.id; this._role = actor.role; this._invalid = !positive(options.patient_id) || !positive(options.cycle_id)
    this._adoptId = positive(options.ai_decision_id) ? Number(options.ai_decision_id) : 0
    this.setData({ role: actor.role, patientId: this._invalid ? 0 : Number(options.patient_id), cycleId: this._invalid ? 0 : Number(options.cycle_id) }); return this.reload()
  },
  onShow() { if (this._ended) return false; this._active = true; return this.reload() },
  onHide() { this._active = false; this._epoch = (this._epoch || 0) + 1; this._context = null; this._adoption = null; this.setData(blank()) },
  onUnload() { this._ended = true; this.onHide() },
  usable() { const actor = wx.getStorageSync('current_user') || {}; const ok = !this._ended && this._active && actor.id === this._actor && actor.role === this._role &&
    hasValidAnySession() && isPatientSessionLeaseCurrent(this._lease); if (!ok && this._active) { this._ended = true; this.onHide() } return ok },
  current(epoch) { return this.usable() && this._epoch === epoch },
  pending() { const row = queue.pendingEntries().find(item => item.kind === 'cycle_review' && item.payload.cycle_id === this.data.cycleId && item.payload.patient_id === this.data.patientId)
    this.setData({ pendingId: row ? row.id : '' }) },
  async reload() {
    if (!this.usable() || this.data.busy || this.data.loading) return false
    if (this._invalid) { this.setData({ errorText: '请从实际计划或日期周期进入。' }); return false }
    const epoch = this._epoch = (this._epoch || 0) + 1; this._context = null; this._adoption = null; this.setData({ ...blank(), loading: true }); this.pending()
    try {
      const cycle = await request({ url: `/care/cycles/${this.data.cycleId}` }); if (!this.current(epoch)) return false
      if (cycle.id !== this.data.cycleId || cycle.patient_id !== this.data.patientId || !Array.isArray(cycle.records)) throw new Error('实际周期归属不一致。')
      const history = await request({ url: `/care/cycles/${this.data.cycleId}/reviews` }); if (!this.current(epoch)) return false
      if (history.cycle_id !== cycle.id || history.patient_id !== cycle.patient_id || !Array.isArray(history.items) || history.items.some(row => row.cycle_id !== cycle.id || row.patient_id !== cycle.patient_id)) throw new Error('复核历史来源不一致。')
      this.setData({ cycle, reviews: history.items.map(row => ({ ...row, decisionLabel: LABELS[row.decision] })),
        records: cycle.records.map(row => ({ ...row, focusText: row.content.focus_minutes == null ? '未记录' : `${row.content.focus_minutes} 分钟`, noteText: row.content.note || '未填写备注' })),
        coverageText: `截至 ${cycle.summary.as_of_date}，实际记录 ${cycle.summary.completed_count} / ${cycle.summary.due_count} 天。缺失保持未记录。` })
      if (!history.items.length && ((cycle.cycle_type === 'professional' && this._role === 'researcher') || cycle.cycle_type === 'self')) {
        const ctx = await request({ url: `/care/cycles/${cycle.id}/review-context` }); if (!this.current(epoch)) return false
        if (ctx.cycle_id !== cycle.id || ctx.patient_id !== cycle.patient_id || ctx.actor_user_id !== this._actor || !Array.isArray(ctx.allowed_decisions)) throw new Error('阶段复核确认上下文不一致。')
        this._context = ctx; const actualPlan = ctx.input_snapshot.plan, version = actualPlan && actualPlan.versions[actualPlan.versions.length - 1]
        const start = plusDays(cycle.end_date > ctx.input_snapshot.calendar_today ? cycle.end_date : ctx.input_snapshot.calendar_today, 1)
        this.setData({ canConfirm: true, decisions: ctx.allowed_decisions.map(value => ({ value, label: LABELS[value] })),
          startDate: start, endDate: plusDays(start, 13), title: version ? version.title : '', instructions: version ? version.instructions : '' })
        this.selectDecision({ detail: { value: '0' } })
        if (this._adoptId) {
          const adopted = await request({ url: `/agent/artifact-decisions/${this._adoptId}/adoption-context` }); if (!this.current(epoch)) return false
          if (adopted.id !== this._adoptId || adopted.actor_user_id !== this._actor || adopted.patient_id !== this.data.patientId || adopted.cycle_id !== cycle.id ||
            adopted.target_type !== 'cycle_review' || typeof adopted.content?.text !== 'string') throw new Error('已核对周期摘要与当前周期不一致。')
          this._adoption = adopted; this.setData({ adoptionId: adopted.id, body: adopted.content.text,
            statusText: '已带入本人核对的周期摘要。仍须填写局限、原因，并单独确认实际阶段决定；不会修改日期原件。' })
        }
      }
      this.setData({ loading: false }); return true
    } catch (failure) { if (this.current(epoch)) this.setData({ loading: false, canConfirm: false, errorText: failure.message || '阶段材料暂未读取成功。' }); return false }
  },
  selectDecision(event) { if (!this.usable() || this.data.busy || this.data.pendingId) return false
    const index = Number(event.detail.value), row = this.data.decisions[index]; if (!row) return false
    const needsPlan = ['continue', 'adjust'].includes(row.value)
    this.setData({ decisionIndex: index, needsPlan, needsDates: needsPlan || this.data.cycle.cycle_type === 'self' && row.value === 'next_round' }); return true },
  onField(event) { if (this.usable() && !this.data.busy && !this.data.pendingId && !(this.data.adoptionId && event.currentTarget.dataset.field === 'body') && ['body','limitations','reason','title','instructions','startDate','endDate'].includes(event.currentTarget.dataset.field)) this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },
  async confirmReview() {
    if (!this.usable() || this.data.loading || this.data.busy || this.data.pendingId || !this._context || !this.data.canConfirm) return false
    if (![this.data.body,this.data.reason,this.data.limitations].every(value => value.trim())) { this.setData({ errorText: '请填写实际复核意见、局限和后续原因。' }); return false }
    const epoch = this._epoch = (this._epoch || 0) + 1, ctx = this._context, selected = this.data.decisions[this.data.decisionIndex]
    this.setData({ busy: true, errorText: '' })
    const agreed = await new Promise(resolve => wx.showModal({ title: '确认实际阶段决定', content: `${selected.label}。依据当前实际日期和材料确认；原记录不改写，下一轮草案仍须另行明确发布。`, success: result => resolve(result.confirm === true), fail: () => resolve(false) }))
    if (!this.current(epoch)) return false
    if (!agreed) { this.setData({ busy: false }); return false }
    try {
      const id = this._adoption ? this._adoption.target_client_id : `stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 13)}`
      const dates = { start_date: this.data.startDate, end_date: this.data.endDate }
      const payload = { client_cycle_review_id: id, patient_id: this.data.patientId, cycle_id: this.data.cycleId,
        expected_previous_version: ctx.expected_previous_version, input_digest: ctx.input_digest, review_context: ctx.review_context,
        decision: selected.value, body: this.data.body, limitations: this.data.limitations, reason: this.data.reason,
        followup_plan: this.data.needsPlan ? { ...dates, title: this.data.title, instructions: this.data.instructions } : null,
        next_cycle: !this.data.needsPlan && this.data.needsDates ? dates : null, confirmed: true,
        ...(this._adoption ? { source_ai_decision_id: this._adoption.id } : {}) }
      queue.enqueue({ id, kind: 'cycle_review', route: '/care/cycle-reviews', expected_context_digest: ctx.review_context_digest, payload }); this.pending()
      const ack = await queue.syncQueuedAcknowledgement(id); if (!this.current(epoch)) return false
      this.setData({ busy: false }); this.pending()
      if (!ack) { this.setData({ statusText: '原件已保存在本机，尚未确认服务器接收。请按原编号查询。' }); return false }
      this._adoptId = 0; this._adoption = null; return this.reload()
    } catch (failure) { if (this.current(epoch)) this.setData({ busy: false, errorText: failure.message || '确认未完成，请保留原件。' }); return false }
  },
  async queryPending() { if (!this.usable() || this.data.busy || !this.data.pendingId) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true }); const ack = await queue.queryQueuedStatus(this.data.pendingId)
    if (!this.current(epoch)) return false
    this.setData({ busy: false }); this.pending(); if (ack) await this.reload(); return Boolean(ack) },
  openNext(event) { if (!this.usable() || this.data.busy) return false
    const row = this.data.reviews.find(value => value.id === Number(event.currentTarget.dataset.id)); if (!row) return false
    const url = row.next_assessment_id && this._role === 'researcher' ? `/pages/assessments/index?patient_id=${this.data.patientId}&assessment_id=${row.next_assessment_id}`
      : row.next_plan_version_id && row.assessment_id ? `/pages/${this._role === 'researcher' ? 'doctor-plan' : 'patient-plan'}/index?patient_id=${this.data.patientId}&assessment_id=${row.assessment_id}`
        : row.next_cycle_id && this._role === 'patient' ? `/pages/care-cycles/index?patient_id=${this.data.patientId}&cycle_id=${row.next_cycle_id}` : ''
    if (!url) return false; wx.navigateTo({ url }); return true },
  openRecovery() { if (this.usable()) wx.navigateTo({ url: '/pages/submission-queue/index' }) }
}, () => hasValidAnySession()))
