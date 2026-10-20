const { registerDoctorPage } = require('../../utils/doctor-page')
const { request } = require('../../utils/request')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const queue = require('../../utils/submission-queue')
const positive = value => Number.isInteger(Number(value)) && Number(value) > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const TYPES = [{ value: 'evidence_review', label: '材料审核' }, { value: 'screening_opinion', label: '医生筛查意见' }]
const QUALITY = { valid: '有效', limited: '有局限', invalid: '无效' }
const ACCEPTANCE = { pending_review: '待医生验收', accepted: '医生已验收', needs_repeat: '需要重测', rejected: '已退回', not_required: '无需医生验收' }
const blank = () => ({ context: null, submissions: [], attempts: [], items: [], backgroundText: '', body: '', limitations: '',
  category: 'evidence_review', categories: TYPES, drafts: [], selectedDraft: null, reports: [], selectedReport: null,
  pendingId: '', pendingKind: '', pendingStatus: '', canArchivePending: false, adoptionId: 0, errorText: '', statusText: '' })
const errorText = failure => [403, 409].includes(failure.statusCode) ? '权限、材料或版本已变化，请保留原件并重新核对。' : failure.message || '读取或保存未完成，请重试。'
const confirm = (title, content) => new Promise(resolve => wx.showModal({ title, content, success: value => resolve(value.confirm === true), fail: () => resolve(false) }))
const idFor = kind => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 13)}`

registerDoctorPage({
  assistantDraftKey: 'doctor-review',
  data: { ...blank(), patientId: 0, assessmentId: 0, loading: false, busy: false },
  onLoad(options = {}) {
    this._active = true; this._lease = capturePatientSessionLease()
    const user = wx.getStorageSync('current_user') || {}; this._actor = user.id
    this._adoptId = positive(options.ai_decision_id) ? Number(options.ai_decision_id) : 0
    this._invalid = !positive(options.patient_id) || !positive(options.assessment_id)
    this.setData({ patientId: this._invalid ? 0 : Number(options.patient_id), assessmentId: this._invalid ? 0 : Number(options.assessment_id) })
    return this.reload()
  },
  onShow() { if (this._ended) return false; this._active = true; return this.reload() },
  onHide() { this._active = false; this._epoch = (this._epoch || 0) + 1; this._context = null; this._draft = null; this._adoption = null;
    this.setData({ ...blank(), loading: false, busy: false }) },
  onUnload() { this._ended = true; this.onHide() },
  onPatientSessionEnded() { this._ended = true; this.onHide() },
  _usable() {
    const user = wx.getStorageSync('current_user') || {}
    if (!this._active || this._ended) return false
    if (user.role !== 'researcher' || user.id !== this._actor || !isPatientSessionLeaseCurrent(this._lease)) {
      this.onPatientSessionEnded(); return false
    }
    return true
  },
  _current(epoch) { return this._usable() && this._epoch === epoch },
  _pending() {
    const pending = queue.pendingEntries().find(row => ['review_draft', 'review_publication'].includes(row.kind) && row.payload.assessment_id === this.data.assessmentId)
    this.setData({ pendingId: pending ? pending.id : '', pendingKind: pending ? pending.kind : '', pendingStatus: pending ? pending.status : '', canArchivePending: queue.canArchive(pending) })
  },
  _check(row, actor = false) {
    if (!row || row.patient_id !== this.data.patientId || row.assessment_id !== this.data.assessmentId || (actor && row.actor_user_id !== this._actor)) throw new Error('审核响应归属不一致。')
    return row
  },
  async reload() {
    if (!this._usable() || this.data.loading || this.data.busy) return false
    if (this._invalid) { this.setData({ errorText: '请从当前共享档案的具体评估进入。' }); return false }
    const epoch = this._epoch = (this._epoch || 0) + 1
    this._context = null; this._draft = null; this._adoption = null; this.setData({ ...blank(), loading: true }); this._pending()
    try {
      const path = `/care/assessments/${this.data.assessmentId}`
      const [context, drafts, reports] = await Promise.all([
        request({ url: path + '/review-context' }).catch(failure => ({ denied: true, failure })),
        request({ url: path + '/reviews' }), request({ url: path + '/reports' })
      ])
      if (!this._current(epoch)) return false
      if (!drafts || !Array.isArray(drafts.items) || !reports || !Array.isArray(reports.items)) throw new Error('审核历史不完整。')
      drafts.items.forEach(row => this._check(row, true)); reports.items.forEach(row => this._check(row))
      this.setData({ drafts: drafts.items, reports: reports.items, loading: false })
      if (context.denied) { this.setData({ errorText: errorText(context.failure) }); return false }
      this._check(context)
      if (context.responsible_doctor_id !== this._actor || !positive(context.assessment_version) || !digest(context.input_digest) ||
        !digest(context.review_context_digest) || typeof context.review_context !== 'string' || !Array.isArray(context.submissions) || !Array.isArray(context.attempts) || !Array.isArray(context.items)) throw new Error('审核输入不完整或负责医生不一致。')
      this._context = context
      this.setData({ context: { version: context.assessment_version, inputDigest: context.input_digest, demonstrationOnly: context.demonstration_only === true },
        submissions: context.submissions.map(row => ({ ...row, decision: '', reason: '',
          qualityLabel: QUALITY[row.quality_status] || '待核对', acceptanceLabel: ACCEPTANCE[row.acceptance_status] || '待核对',
          originalText: JSON.stringify({ source: row.server_result, content: row.content, execution: row.execution_metadata }, null, 2) })),
        attempts: context.attempts, items: context.items,
        backgroundText: context.background && context.background.visibility === 'withheld' ? '背景资料未共享' : JSON.stringify(context.background && context.background.fields || {}, null, 2) })
      if (this._adoptId && !this.data.pendingId) {
        const adopted = await request({ url: `/agent/artifact-decisions/${this._adoptId}/adoption-context` }); if (!this._current(epoch)) return false
        if (adopted.id !== this._adoptId || adopted.actor_user_id !== this._actor || adopted.patient_id !== this.data.patientId ||
          adopted.assessment_id !== this.data.assessmentId || adopted.target_type !== 'review_draft') throw new Error('已核对摘要草稿与当前审核材料不一致。')
        this._adoption = adopted; this.setData({ adoptionId: adopted.id, body: adopted.content.text })
      }
      return true
    } catch (failure) {
      if (this._current(epoch)) { this._context = null; this.setData({ loading: false, context: null, submissions: [], attempts: [], items: [], backgroundText: '', errorText: errorText(failure) }) }
      return false
    }
  },
  onFieldInput(event) {
    const field = event.currentTarget.dataset.field
    if (this._usable() && !this.data.busy && !this.data.pendingId && !this.data.selectedDraft && !(field === 'body' && this.data.adoptionId) && ['body', 'limitations'].includes(field)) this.setData({ [field]: event.detail.value })
  },
  onCategoryChange(event) {
    if (this._usable() && !this.data.busy && !this.data.pendingId && !this.data.selectedDraft && TYPES.some(row => row.value === event.detail.value)) this.setData({ category: event.detail.value })
  },
  onDecisionChange(event) {
    if (!this._usable() || this.data.busy || this.data.pendingId || this.data.selectedDraft) return false
    const id = event.currentTarget.dataset.id, decision = event.detail.value
    if (!['accepted', 'needs_repeat', 'rejected'].includes(decision)) return false
    this.setData({ submissions: this.data.submissions.map(row => row.submission_id === id ? { ...row, decision: row.quality_status === 'invalid' && decision === 'accepted' ? '' : decision } : row) })
    return true
  },
  onDecisionReason(event) {
    if (!this._usable() || this.data.busy || this.data.pendingId || this.data.selectedDraft) return false
    const id = event.currentTarget.dataset.id
    this.setData({ submissions: this.data.submissions.map(row => row.submission_id === id ? { ...row, reason: event.detail.value } : row) }); return true
  },
  async saveDraft() {
    if (!this._usable() || this.data.busy || this.data.loading || this.data.pendingId || !this._context || this.data.selectedDraft) return false
    if (!this.data.body.trim() || !this.data.limitations.trim() || !this.data.submissions.length || this.data.submissions.some(row => !row.decision || !row.reason.trim())) {
      this.setData({ errorText: '请逐份核对并选择决定、填写实际理由，以及正文和局限。' }); return false
    }
    const epoch = this._epoch = (this._epoch || 0) + 1, ctx = this._context
    const id = this._adoption ? this._adoption.target_client_id : idFor('review'), payload = { client_review_id: id, patient_id: this.data.patientId, assessment_id: this.data.assessmentId,
      expected_assessment_version: ctx.assessment_version, input_digest: ctx.input_digest, review_context: ctx.review_context,
      category: this.data.category, body: this.data.body, limitations: this.data.limitations,
      decisions: this.data.submissions.map(row => ({ submission_id: row.submission_id, assessment_item_id: row.assessment_item_id,
          attempt_id: row.attempt_id, decision: row.decision, reason: row.reason })),
      ...(this._adoption ? { source_ai_decision_id: this._adoption.id } : {}), confirmed: true }
    this.setData({ busy: true, errorText: '', statusText: '' })
    try {
      const agreed = await confirm('确认保存私人审核草稿', '已核对本轮全部实际提交和局限。本次仅保存本人审核草稿，发布须再次明确确认。')
      if (!this._current(epoch)) return false
      if (!agreed) { this.setData({ busy: false }); return false }
      queue.enqueue({ id, kind: 'review_draft', route: '/care/reviews', expected_context_digest: ctx.review_context_digest, payload })
      this._pending()
      const ack = await queue.syncQueuedAcknowledgement(id)
      if (!this._current(epoch)) return false
      this.setData({ busy: false }); this._pending()
      if (!ack) { this.setData({ statusText: '原审核草稿已保存在本机，服务器尚未确认；请查询原编号。' }); return false }
      this._adoptId = 0; this._adoption = null
      const next = this._epoch + 1, refreshed = await this.reload()
      if (this._current(next)) this.setData({ statusText: refreshed ? '服务器已确认私人草稿。请打开该草稿核对后再发布。' : '服务器已确认草稿，历史刷新失败，请重新读取。' })
      return true
    } catch (failure) { if (this._current(epoch)) this.setData({ busy: false, errorText: errorText(failure) }); return false }
  },
  async openDraft(event) {
    if (!this._usable() || this.data.busy || this.data.pendingId) return false
    const id = Number(event.currentTarget.dataset.id)
    if (!this.data.drafts.some(row => row.id === id)) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, errorText: '' })
    try {
      const row = this._check(await request({ url: `/care/reviews/${id}` }), true)
      if (!this._current(epoch)) return false
      if (row.id !== id || row.status !== 'draft' || !digest(row.payload_digest) || !row.input_snapshot) throw new Error('草稿原件读取不完整。')
      this._draft = row
      this.setData({ busy: false, selectedDraft: row, body: row.body, limitations: row.limitations,
        category: row.category, submissions: (row.input_snapshot.submissions || []).map(value => ({ ...value,
          ...(row.decisions.find(decision => decision.submission_id === value.submission_id) || {}),
          qualityLabel: QUALITY[value.quality_status] || '待核对', acceptanceLabel: ACCEPTANCE[value.acceptance_status] || '待核对',
          originalText: JSON.stringify(value.server_result, null, 2) })) })
      return true
    } catch (failure) { if (this._current(epoch)) { this._draft = null; this.setData({ busy: false, selectedDraft: null, errorText: errorText(failure) }) } return false }
  },
  async publish() {
    if (!this._usable() || this.data.busy || this.data.pendingId || !this._draft) return false
    const draft = this._draft, epoch = this._epoch = (this._epoch || 0) + 1
    this.setData({ busy: true, errorText: '', statusText: '' })
    try {
      const ctx = this._check(await request({ url: `/care/reviews/${draft.id}/publication-context` }), true)
      if (!this._current(epoch)) return false
      if (ctx.review_id !== draft.id || ctx.review_payload_digest !== draft.payload_digest || ctx.input_digest !== draft.input_digest || !digest(ctx.publication_context_digest)) throw new Error('发布核对与已读取草稿不一致。')
      const agreed = await confirm('确认发布医生意见', `发布已读取的${draft.category === 'evidence_review' ? '材料审核' : '筛查意见'}及局限，形成新的报告版本。材料审核和筛查意见不等同于诊断。${draft.demonstration_only ? '本轮为演示资料。' : ''}`)
      if (!this._current(epoch)) return false
      if (!agreed) { this.setData({ busy: false }); return false }
      const id = idFor('publication'), payload = { client_publication_id: id, patient_id: this.data.patientId, assessment_id: this.data.assessmentId,
        review_id: draft.id, expected_assessment_version: ctx.expected_assessment_version,
        expected_previous_report_version: ctx.expected_previous_report_version, input_digest: draft.input_digest,
        publication_context: ctx.publication_context, confirmed: true }
      queue.enqueue({ id, kind: 'review_publication', route: '/care/review-publications', expected_context_digest: ctx.publication_context_digest,
        expected_review: { id: draft.id, payload_digest: draft.payload_digest, category: draft.category, body: draft.body, limitations: draft.limitations,
          decisions: draft.decisions, source_ai_decision_id: draft.source_ai_decision_id == null ? null : draft.source_ai_decision_id }, payload })
      this._pending(); const ack = await queue.syncQueuedAcknowledgement(id)
      if (!this._current(epoch)) return false
      this.setData({ busy: false }); this._pending()
      if (!ack) { this.setData({ statusText: '原发布确认已保存在本机，尚未确认。请按原编号查询，不要重复建立发布。' }); return false }
      const next = this._epoch + 1, refreshed = await this.reload()
      if (this._current(next)) this.setData({ statusText: refreshed ? `服务器已确认报告版本 ${ack.version}。` : `服务器已确认报告版本 ${ack.version}；历史刷新失败，请重新读取。` })
      return true
    } catch (failure) { if (this._current(epoch)) this.setData({ busy: false, errorText: errorText(failure) }); return false }
  },
  async queryPending() {
    if (!this._usable() || this.data.busy || !this.data.pendingId) return false
    const epoch = this._epoch = (this._epoch || 0) + 1, id = this.data.pendingId
    this.setData({ busy: true, errorText: '' }); const result = await queue.queryQueuedStatus(id)
    if (!this._current(epoch)) return false
    this.setData({ busy: false }); this._pending()
    if (result) { this._adoptId = 0; this._adoption = null; const next = this._epoch + 1, refreshed = await this.reload(); if (this._current(next)) this.setData({ statusText: refreshed ? '服务器已确认原编号，历史已重新读取。' : '服务器已确认原编号；历史暂未读取，请刷新核对。' }) }
    else this.setData({ statusText: '原件保留，尚未获得一致的服务器确认。' })
    return Boolean(result)
  },
  async openReport(event) {
    if (!this._usable() || this.data.busy) return false
    const id = Number(event.currentTarget.dataset.id)
    if (!this.data.reports.some(row => row.id === id)) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, selectedReport: null })
    try { const report = this._check(await request({ url: `/care/reports/${id}` })); if (!this._current(epoch)) return false
      this.setData({ busy: false, selectedReport: report }); return true
    } catch (failure) { if (this._current(epoch)) this.setData({ busy: false, errorText: errorText(failure) }); return false }
  },
  openQuestions() { if (this._usable() && !this.data.busy) wx.navigateTo({ url: `/pages/review-questions/index?patient_id=${this.data.patientId}&assessment_id=${this.data.assessmentId}` }) },
  openPlan() { if (this._usable() && !this.data.busy) wx.navigateTo({ url: `/pages/doctor-plan/index?patient_id=${this.data.patientId}&assessment_id=${this.data.assessmentId}` }) },
  openRecovery() { if (this._usable()) wx.navigateTo({ url: '/pages/submission-queue/index' }) }
})
