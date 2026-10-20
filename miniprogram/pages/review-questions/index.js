const { request } = require('../../utils/request')
const { protectPatientPage } = require('../../utils/patient-page')
const { hasValidAnySession } = require('../../utils/role-session')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const queue = require('../../utils/submission-queue')
const positive = value => Number.isInteger(Number(value)) && Number(value) > 0
const confirm = content => new Promise(resolve => wx.showModal({ title: '确认具体补问或答复', content,
  success: result => resolve(result.confirm === true), fail: () => resolve(false) }))
const idFor = type => `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 13)}`
const STATUS = { provided: '已提供', unknown: '不知道', skipped: '已跳过' }
const BACKGROUND = { diagnosis_history: '既往评估情况', medication: '用药情况', other_conditions: '其他健康情况', sleep: '睡眠情况', school_work: '学习或工作情况' }
const blank = () => ({ questions: [], sources: [], sourceIndex: 0, questionText: '', selectedQuestion: null,
  answerStatus: 'unknown', answerText: '', pendingId: '', adoptionId: 0, statusText: '', errorText: '' })
Page(protectPatientPage({
  assistantDraftKey: 'review-questions',
  data: { ...blank(), role: '', patientId: 0, assessmentId: 0, loading: false, busy: false },
  onLoad(options = {}) {
    this._active = true; this._lease = capturePatientSessionLease(); const actor = wx.getStorageSync('current_user') || {}
    this._actor = actor.id; this._role = actor.role
    this._adoptId = positive(options.ai_decision_id) ? Number(options.ai_decision_id) : 0
    this._invalid = !positive(options.patient_id) || !positive(options.assessment_id)
    this.setData({ role: actor.role, patientId: this._invalid ? 0 : Number(options.patient_id), assessmentId: this._invalid ? 0 : Number(options.assessment_id) })
    return this.reload()
  },
  onShow() { if (this._ended) return false; this._active = true; return this.reload() },
  onHide() { this._active = false; this._epoch = (this._epoch || 0) + 1; this._context = null; this._reply = null; this._adoption = null; this.setData({ ...blank(), busy: false, loading: false }) },
  onUnload() { this._ended = true; this.onHide() },
  _usable() { const user = wx.getStorageSync('current_user') || {}; const valid = !this._ended && this._active &&
    user.id === this._actor && user.role === this._role && hasValidAnySession() && isPatientSessionLeaseCurrent(this._lease)
    if (!valid && this._active) { this._ended = true; this.onHide() } return valid },
  _current(epoch) { return this._usable() && epoch === this._epoch },
  _check(value) { if (!value || value.patient_id !== this.data.patientId || value.assessment_id !== this.data.assessmentId) throw new Error('补问记录与当前档案或评估不一致。'); return value },
  _pending() { const row = queue.pendingEntries().find(item => ['review_question', 'clarification_reply'].includes(item.kind) && item.payload.assessment_id === this.data.assessmentId)
    this.setData({ pendingId: row ? row.id : '' }) },
  async reload() {
    if (!this._usable() || this.data.loading || this.data.busy) return false
    if (this._invalid) { this.setData({ errorText: '请从具体评估进入补问。' }); return false }
    const epoch = this._epoch = (this._epoch || 0) + 1; this._context = null; this._reply = null; this._adoption = null
    this.setData({ ...blank(), loading: true }); this._pending()
    try {
      const path = `/care/assessments/${this.data.assessmentId}`
      const result = this._check(await request({ url: path + '/clarifications' })); if (!this._current(epoch)) return false
      if (!Array.isArray(result.items)) throw new Error('补问列表不完整。')
      const questions = result.items.map(row => { this._check(row); return { ...row, sourceLabel: row.source_type === 'background' ? BACKGROUND[row.source_key] : `原提交 ${row.source_key}`,
        replies: (row.replies || []).map(reply => { this._check(reply); return { ...reply, statusLabel: STATUS[reply.answer_status] || '待核对' } }) } })
      this.setData({ questions })
      if (this._role === 'researcher') {
        const context = this._check(await request({ url: path + '/review-context' })); if (!this._current(epoch)) return false
        if (context.responsible_doctor_id !== this._actor) throw new Error('当前医生不是本轮负责医生。')
        this._context = context
        const sources = (context.submissions || []).map(row => ({ source_type: 'submission', source_key: row.submission_id, label: `原提交 ${row.submission_id}` }))
        if (context.background && context.background.visibility === 'shared') Object.entries(BACKGROUND).forEach(([key, label]) => sources.push({ source_type: 'background', source_key: key, label }))
        this.setData({ sources })
        if (this._adoptId && !this.data.pendingId) {
          const adopted = await request({ url: `/agent/artifact-decisions/${this._adoptId}/adoption-context` }); if (!this._current(epoch)) return false
          if (adopted.id !== this._adoptId || adopted.actor_user_id !== this._actor || adopted.patient_id !== this.data.patientId ||
            adopted.assessment_id !== this.data.assessmentId || adopted.target_type !== 'review_question') throw new Error('已核对草稿与当前具体补问不一致。')
          const index = sources.findIndex(row => row.source_type === adopted.content.source_type && row.source_key === adopted.content.source_key)
          if (index < 0) throw new Error('草稿原件已不在当前可核对来源中。')
          this._adoption = adopted; this.setData({ adoptionId: adopted.id, sourceIndex: index, questionText: adopted.content.question })
        }
      }
      this.setData({ loading: false }); return true
    } catch (failure) { if (this._current(epoch)) this.setData({ loading: false, errorText: failure.message || '读取失败，请刷新。' }); return false }
  },
  onSourceChange(event) { if (this._usable() && !this.data.busy && !this.data.adoptionId) this.setData({ sourceIndex: Number(event.detail.value) }) },
  onQuestionInput(event) { if (this._usable() && !this.data.busy && !this.data.adoptionId) this.setData({ questionText: event.detail.value }) },
  onAnswerInput(event) { if (this._usable() && !this.data.busy) this.setData({ answerText: event.detail.value }) },
  onAnswerStatus(event) { if (this._usable() && !this.data.busy && Object.hasOwn(STATUS, event.detail.value)) this.setData({ answerStatus: event.detail.value, answerText: '' }) },
  async ask() {
    if (!this._usable() || this._role !== 'researcher' || this.data.busy || this.data.pendingId || !this._context) return false
    const source = this.data.sources[this.data.sourceIndex], text = this.data.questionText
    if (!source || !text.trim()) { this.setData({ errorText: '请选择具体原件或单个背景项目，填写实际问题。' }); return false }
    const ctx = this._context, id = this._adoption ? this._adoption.target_client_id : idFor('question')
    return this._submit('review_question', id, '/care/clarifications', ctx.review_context_digest, {
      client_question_id: id, patient_id: this.data.patientId, assessment_id: this.data.assessmentId,
      expected_assessment_version: ctx.assessment_version, input_digest: ctx.input_digest, review_context: ctx.review_context,
      source_type: source.source_type, source_key: source.source_key, question: text,
      ...(this._adoption ? { source_ai_decision_id: this._adoption.id } : {}), confirmed: true }, '向当前用户提出这一个具体问题；其他背景仍可跳过。')
  },
  async selectQuestion(event) {
    if (!this._usable() || this._role !== 'patient' || this.data.busy || this.data.pendingId) return false
    const id = Number(event.currentTarget.dataset.id), question = this.data.questions.find(row => row.id === id)
    if (!question) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this._reply = null; this.setData({ busy: true, selectedQuestion: null, errorText: '' })
    try { const ctx = this._check(await request({ url: `/care/clarifications/${id}/reply-context` })); if (!this._current(epoch)) return false
      if (ctx.question_id !== id || ctx.actor_user_id !== this._actor || ctx.question_payload_digest !== question.payload_digest) throw new Error('答复上下文与实际问题不一致。')
      this._reply = ctx; this.setData({ busy: false, selectedQuestion: question, answerStatus: 'unknown', answerText: '' }); return true
    } catch (failure) { if (this._current(epoch)) this.setData({ busy: false, errorText: failure.message || '当前不能答复，请刷新核对授权。' }); return false }
  },
  async answer() {
    if (!this._usable() || this._role !== 'patient' || this.data.busy || this.data.pendingId || !this._reply || !this.data.selectedQuestion) return false
    const ctx = this._reply, id = idFor('reply'), state = this.data.answerStatus
    if (state === 'provided' && !this.data.answerText.trim()) { this.setData({ errorText: '请填写实际答复，也可选择不知道或跳过。' }); return false }
    return this._submit('clarification_reply', id, '/care/clarification-replies', ctx.reply_context_digest, {
      client_reply_id: id, patient_id: this.data.patientId, assessment_id: this.data.assessmentId, question_id: ctx.question_id,
      expected_assessment_version: ctx.assessment_version, expected_previous_revision: ctx.expected_previous_revision,
      reply_context: ctx.reply_context, answer_status: state, answer: state === 'provided' ? this.data.answerText : null, confirmed: true },
    `确认向负责医生答复这一个问题：${STATUS[state]}。本次答复保留为新版本，不改写原始背景或结果。`)
  },
  async _submit(kind, id, route, digest, payload, message) {
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, errorText: '', statusText: '' })
    try {
      const agreed = await confirm(message); if (!this._current(epoch)) return false
      if (!agreed) { this.setData({ busy: false }); return false }
      queue.enqueue({ id, kind, route, expected_context_digest: digest, payload }); this._pending()
      const ack = await queue.syncQueuedAcknowledgement(id); if (!this._current(epoch)) return false
      this.setData({ busy: false }); this._pending()
      if (!ack) { this.setData({ statusText: '原件已保存在本机，服务器确认尚未取得。请按原编号查询。' }); return false }
      this._adoptId = 0; this._adoption = null
      await this.reload(); return true
    } catch (failure) { if (this._current(epoch)) this.setData({ busy: false, errorText: failure.message || '尚未保存，请保留内容重试。' }); return false }
  },
  async queryPending() {
    if (!this._usable() || this.data.busy || !this.data.pendingId) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true })
    const ack = await queue.queryQueuedStatus(this.data.pendingId); if (!this._current(epoch)) return false
    this.setData({ busy: false }); this._pending(); if (ack) { this._adoptId = 0; this._adoption = null; await this.reload() }
    return Boolean(ack)
  },
  openRecovery() { if (this._usable()) wx.navigateTo({ url: '/pages/submission-queue/index' }) }
}, () => hasValidAnySession()))
