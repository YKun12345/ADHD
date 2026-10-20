const { request } = require('../../utils/request')
const { protectPatientPage } = require('../../utils/patient-page')
const { hasValidAnySession } = require('../../utils/role-session')
const { ensurePatientSession, capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const { executionUrl } = require('../../utils/assessment-execution')
const { itemTitle, templateTitle } = require('../../utils/assessment-presentation')

const STATUS = Object.freeze({ draft: '待发布', active: '进行中', evidence_ready: '材料已齐', closed_self: '自助已完成',
  under_review: '等待医生审核', reviewed: '医生已复核', suspended: '已暂停', cancelled: '已取消',
  not_started: '未开始', in_progress: '已开始', submitted: '已提交', pending_validation: '待验证',
  valid: '有效', limited: '有局限', invalid: '无效', not_required: '无需医生验收', pending_review: '待医生验收',
  accepted: '医生已验收', needs_repeat: '需要重测', rejected: '已拒绝' })
const BACKGROUND = Object.freeze([
  { key: 'diagnosis_history', label: '既往评估情况' }, { key: 'medication', label: '相关用药情况' },
  { key: 'other_conditions', label: '其他健康情况' }, { key: 'sleep', label: '睡眠情况' },
  { key: 'school_work', label: '学习或工作情况' }
])
const emptyBackground = () => BACKGROUND.map(field => ({ ...field, status: 'skipped', value: '' }))
const positiveId = value => Number.isInteger(Number(value)) && Number(value) > 0
const label = value => STATUS[value] || '状态待确认'

Page(protectPatientPage({
  assistantDraftKey: 'assessments',
  data: { role: 'patient', patientId: 0, patientName: '', patientType: '', templates: [], selectedTemplateId: '',
    backgroundFields: emptyBackground(), sessions: [], assessment: null, itemViews: [], backgroundViews: [], loading: false, busy: false,
    canCreate: false, backgroundProcessingAllowed: false, admissionText: '', errorText: '', statusText: '', respondentConfirmed: false, assistanceProvided: false, adoptionId: 0 },
  async onLoad(options = {}) {
    this._active = true
    const lease = capturePatientSessionLease()
    this._entryLease = lease
    this._adoptId = positiveId(options.ai_decision_id) ? Number(options.ai_decision_id) : 0
    const user = wx.getStorageSync('current_user') || {}
    this.setData({ role: user.role, patientId: positiveId(options.patient_id) ? Number(options.patient_id) : 0 })
    const loaded = await this.reload()
    if (!loaded || !this._active || !isPatientSessionLeaseCurrent(lease)) return false
    if (options.assessment_id !== undefined) {
      if (!positiveId(options.assessment_id) || !this.data.sessions.some(row => row.id === Number(options.assessment_id))) {
        this.setData({ errorText: '本轮记录不在当前可读范围内，请核对档案后刷新。' }); return false
      }
      return this.openAssessment({ currentTarget: { dataset: { id: Number(options.assessment_id) } } })
    }
    return true
  },
  onShow() { this._active = true; if (!this.data.loading) return this.reload() },
  onHide() {
    this._active = false; this._version = (this._version || 0) + 1
    this._adoption = null
    this.setData({ assessment: null, itemViews: [], backgroundViews: [], sessions: [], templates: [], patientName: '', backgroundFields: emptyBackground(),
      loading: false, busy: false, canCreate: false, backgroundProcessingAllowed: false, respondentConfirmed: false, adoptionId: 0, statusText: '' })
  },
  onUnload() { this.onHide() },
  _current(lease, version) { return this._active && this._version === version && isPatientSessionLeaseCurrent(lease) && isPatientSessionLeaseCurrent(this._entryLease) },
  _canCreate(template) { return template && ['test_only', 'reference_use'].includes(template.admission_status) &&
    template[this.data.role === 'researcher' ? 'can_create_doctor_assigned' : 'can_create_self'] === true },
  async reload() {
    if (this.data.loading || this.data.busy) return false
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1
    this._version = version
    this._adoption = null
    this.setData({ loading: true, errorText: '' })
    try {
      let patientId = this.data.patientId
      if (this.data.role === 'patient') {
        const context = await request({ url: '/identity/context' })
        if (!this._current(lease, version)) return false
        const patients = context.accessible_patients || []
        const patient = patientId ? patients.find(row => row.patient_id === patientId) : patients[0]
        if (!patient) throw new Error('尚未读取到本人或儿童档案，请到“我的－账号与隐私”查看资料或确认监护关系。')
        patientId = patient.patient_id
        this.setData({ patientId, patientName: patient.display_name || `档案 #${patientId}`, patientType: patient.patient_type })
      } else if (!positiveId(patientId)) {
        throw new Error('请从患者随访页选择已共享的档案。')
      } else this.setData({ patientName: `共享档案 #${patientId}` })
      const [templates, sessions] = await Promise.all([
        request({ url: `/care/assessment-templates?patient_id=${patientId}` }),
        request({ url: `/care/assessments?patient_id=${patientId}` })
      ])
      if (!this._current(lease, version)) return false
      const items = Array.isArray(templates.items) ? templates.items.map(row => ({...row,title:templateTitle(row)})) : []
      const selected = items.find(item => this._canCreate(item))
      this.setData({ templates: items, sessions: (sessions.items || []).map(row => ({ ...row, statusLabel: label(row.status) })),
        selectedTemplateId: selected && selected.id || '', canCreate: Boolean(selected),
        backgroundProcessingAllowed: Boolean(selected && selected.background_processing_allowed === true),
        backgroundFields: selected && selected.background_processing_allowed === true ? this.data.backgroundFields : emptyBackground(), loading: false,
        admissionText: selected ? (selected.usage_notice || '参考评估用于了解注意状态，不替代医生诊断。') : items.some(item => ['test_only', 'reference_use'].includes(item.admission_status))
          ? '当前使用或共享授权不满足新建要求，可以查看已有评估。' : '当前模板尚未完成准入审核，暂不能新建评估。' })
      if (this._adoptId) {
        const adopted = await request({ url: `/agent/artifact-decisions/${this._adoptId}/adoption-context` })
        if (!this._current(lease, version)) return false
        const actor = wx.getStorageSync('current_user') || {}, fields = adopted.content && adopted.content.fields
        if (adopted.id !== this._adoptId || adopted.actor_user_id !== actor.id || adopted.patient_id !== patientId || adopted.target_type !== 'assessment_background' || !fields || !Object.keys(fields).length ||
          Object.keys(fields).some(key => !BACKGROUND.some(row => row.key === key))) throw new Error('已核对的背景来源与当前档案不一致。')
        if (Object.values(fields).some(field => field.status === 'provided') && (!selected || selected.background_processing_allowed !== true)) throw new Error('当前未授权处理已提供背景，请重新核对权限。')
        this._adoption = adopted
        this.setData({ adoptionId: adopted.id, backgroundFields: BACKGROUND.filter(row => Object.prototype.hasOwnProperty.call(fields, row.key))
          .map(row => ({ ...row, status: fields[row.key].status, value: fields[row.key].value || '', confirmed: false })),
          statusText: '已带入本人核对的背景建议。请逐项再次核对后创建本轮；修改内容请回星仔重新核对。' })
      }
      return true
    } catch (error) {
      if (!this._current(lease, version)) return false
      this._adoption = null
      this.setData({ loading: false, templates: [], sessions: [], assessment: null, itemViews: [], backgroundViews: [], canCreate: false, backgroundProcessingAllowed: false, backgroundFields: emptyBackground(), adoptionId: 0,
        errorText: error.message || '评估读取失败，请重试' })
      return false
    }
  },
  selectTemplate(event) {
    const id = event.currentTarget.dataset.id
    const template = this.data.templates.find(row => row.id === id && this._canCreate(row))
    if (!this.data.busy && template) this.setData({ selectedTemplateId: id, backgroundProcessingAllowed: template.background_processing_allowed === true,
      backgroundFields: template.background_processing_allowed === true ? this.data.backgroundFields : emptyBackground() })
  },
  setBackgroundStatus(event) {
    const index = Number(event.currentTarget.dataset.index), value = event.detail.value
    if (this.data.adoptionId || this.data.busy || !this.data.backgroundFields[index] || !['skipped', 'unknown', 'provided'].includes(value) || (value === 'provided' && !this.data.backgroundProcessingAllowed)) return
    const fields = this.data.backgroundFields.map((field, i) => i === index ? { ...field, status: value, value: value === 'provided' ? field.value : '' } : field)
    this.setData({ backgroundFields: fields })
  },
  setBackgroundValue(event) {
    const index = Number(event.currentTarget.dataset.index)
    if (!this.data.adoptionId && !this.data.busy && this.data.backgroundProcessingAllowed && this.data.backgroundFields[index] && this.data.backgroundFields[index].status === 'provided') this.setData({ backgroundFields: this.data.backgroundFields.map((field, i) => i === index ? { ...field, value: event.detail.value } : field) })
  },
  confirmBackgroundField(event) { const index = Number(event.currentTarget.dataset.index)
    if (this._active && isPatientSessionLeaseCurrent(this._entryLease) && !this.data.busy && this.data.adoptionId && this.data.backgroundFields[index]) this.setData({
      backgroundFields: this.data.backgroundFields.map((field, i) => i === index ? { ...field, confirmed: (event.detail.value || []).includes('confirmed') } : field) }) },
  reviseAdoption() { if (this._active && isPatientSessionLeaseCurrent(this._entryLease) && !this.data.busy) wx.navigateTo({ url: `/pages/agent-chat/index?patient_id=${this.data.patientId}` }) },
  setRespondentConfirmation(event) { this.setData({ respondentConfirmed: (event.detail.value || []).includes('confirmed') }) },
  setAssistance(event) { this.setData({ assistanceProvided: (event.detail.value || []).includes('assisted') }) },
  _apply(session) {
    if (!session || !positiveId(session.id) || session.patient_id !== this.data.patientId) throw new Error('评估响应与当前档案不一致，请重新读取。')
    const backgroundViews = Object.entries(session.background || {}).map(([key, field]) => ({ key,
      label: (BACKGROUND.find(item => item.key === key) || {}).label || key,
      value: field.status === 'skipped' ? '已跳过，情况未知' : field.status === 'unknown' ? '不知道' :
        typeof field.value === 'string' ? field.value : JSON.stringify(field.value),
      source: field.source === 'guardian_report' ? '监护人提供' : field.source === 'self_report' ? '本人提供' : '患者反馈' }))
    this.setData({ assessment: { ...session, statusLabel: label(session.status),
      canReview: this.data.role === 'researcher' && session.responsible_doctor_id === (wx.getStorageSync('current_user') || {}).id &&
        session.published_at && !['draft', 'cancelled', 'suspended'].includes(session.status),
      canPublish: this.data.role === 'researcher' && session.status === 'draft' && (session.allowed_actions || []).includes('publish') }, backgroundViews,
      itemViews: (session.items || []).map(item => ({ ...item, title: itemTitle(item), executionLabel: label(item.execution_status), qualityLabel: label(item.quality_status),
        acceptanceLabel: label(item.acceptance_status), canAttempt: this.data.role === 'patient' && (item.allowed_actions || []).includes('create_attempt'),
        canResume: this.data.role === 'patient' && item.repeat_request && item.repeat_request.continuing_attempt_id &&
          (item.attempts || []).some(attempt => attempt.id === item.repeat_request.continuing_attempt_id && attempt.execution_status === 'in_progress') })),
      sessions: [session, ...this.data.sessions.filter(row => row.id !== session.id)].map(row => ({ ...row, statusLabel: label(row.status) })) })
  },
  async _run(action, message) {
    if (this.data.busy) return false
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1
    this._version = version
    this.setData({ busy: true, errorText: '', statusText: '' })
    try {
      const assertCurrent = () => { if (!this._current(lease, version)) throw new Error('会话或页面已变更，请重新操作。') }
      assertCurrent()
      const result = await action(assertCurrent)
      if (!this._current(lease, version)) return false
      this._apply(result)
      this.setData({ busy: false, statusText: message })
      return true
    } catch (error) {
      if (!this._current(lease, version)) return false
      this.setData({ busy: false, assessment: null, itemViews: [], backgroundViews: [], errorText: error.message || '操作未完成，请重试' })
      return false
    }
  },
  createAssessment() {
    const template = this.data.templates.find(row => row.id === this.data.selectedTemplateId && this._canCreate(row))
    if (!template || !this.data.canCreate) return false
    const background = {}
    const source = this.data.role === 'researcher' ? 'patient_report' : this.data.patientType === 'child' ? 'guardian_report' : 'self_report'
    for (const field of this.data.backgroundFields) {
      if (this.data.adoptionId && !field.confirmed) { this.setData({ errorText: '请逐项勾选确认带入的背景内容和状态。' }); return false }
      if (field.status === 'provided' && template.background_processing_allowed !== true) { this.setData({ errorText: '当前未授权处理背景资料，请选择不知道或跳过。' }); return false }
      if (field.status === 'provided' && !field.value.trim()) { this.setData({ errorText: '已选择提供的背景需要填写内容；也可以选择不知道或跳过。' }); return false }
      background[field.key] = { status: field.status, value: field.status === 'provided' ? this.data.adoptionId ? field.value : field.value.trim() : null, source, confirmed: true }
    }
    const adopted = this._adoption
    return this._run(async assertCurrent => {
      if (adopted) {
        const agreed = await new Promise(resolve => wx.showModal({ title: '确认保存本轮实际背景', content: '将你逐项核对的背景保存到新建的这一轮评估。不会改写旧评估或生成测评结果。', success: result => resolve(result.confirm === true), fail: () => resolve(false) }))
        assertCurrent(); if (!agreed) throw new Error('尚未保存，你可以继续核对。')
      }
      const result = await request({ url: `/care/${this.data.role === 'researcher' ? 'doctor' : 'patient'}/assessments`, method: 'POST',
        data: { patient_id: this.data.patientId, template_id: template.id, template_version: template.version, previous_assessment_id: null, background,
          ...(adopted ? { source_ai_decision_id: adopted.id, client_assessment_id: adopted.target_client_id } : {}) } })
      assertCurrent(); this._adoptId = 0; this._adoption = null; this.setData({ adoptionId: 0, backgroundFields: emptyBackground() }); return result
    }, '本轮评估已保存。')
  },
  openAssessment(event) {
    const id = event.currentTarget.dataset.id
    if (!positiveId(id)) return false
    return this._run(() => request({ url: `/care/assessments/${Number(id)}` }), '已读取本轮资料。')
  },
  publishAssessment() {
    const session = this.data.assessment
    if (this.data.role !== 'researcher' || !session || !(session.allowed_actions || []).includes('publish')) return false
    return this._run(() => request({ url: `/care/assessments/${session.id}/publish`, method: 'POST', data: { expected_version: session.version } }), '评估已发布，用户可查看具体项目。')
  },
  openReview() {
    const row = this.data.assessment
    if (!this._active || !row || !row.canReview || this.data.busy) return false
    wx.navigateTo({ url: `/pages/doctor-review/index?patient_id=${this.data.patientId}&assessment_id=${row.id}` }); return true
  },
  openReports() {
    const row = this.data.assessment
    if (!this._active || !row || this.data.busy) return false
    wx.navigateTo({ url: `/pages/care-reports/index?patient_id=${this.data.patientId}&assessment_id=${row.id}` }); return true
  },
  openQuestions() {
    const row = this.data.assessment
    if (!this._active || !isPatientSessionLeaseCurrent(this._entryLease) || !row || this.data.busy || row.source !== 'doctor_assigned') return false
    wx.navigateTo({ url: `/pages/review-questions/index?patient_id=${this.data.patientId}&assessment_id=${row.id}` }); return true
  },
  openPlan() {
    const row = this.data.assessment
    if (!this._active || !isPatientSessionLeaseCurrent(this._entryLease) || !row || this.data.busy || row.source !== 'doctor_assigned') return false
    wx.navigateTo({ url: `/pages/${this.data.role === 'researcher' ? 'doctor-plan' : 'patient-plan'}/index?patient_id=${this.data.patientId}&assessment_id=${row.id}` }); return true
  },
  async createAttempt(event) {
    const item = this.data.itemViews.find(row => row.id === Number(event.currentTarget.dataset.id))
    if (!item || !item.canAttempt || !this.data.respondentConfirmed) { this.setData({ errorText: '请确认由被评估者执行认知项目、由指定观察者填写量表。' }); return false }
    let device = { platform: 'miniprogram', device_type: 'unknown', environment: 'unknown' }
    try { const info = wx.getSystemInfoSync(); device = { platform: 'miniprogram', environment: info.platform || 'unknown',
      device_type: info.platform === 'devtools' ? 'simulator' : ['ios', 'android'].includes(info.platform) ? 'phone' : 'unknown',
      device_model: info.model || null, viewport_width: info.windowWidth, viewport_height: info.windowHeight } } catch (_) {}
    const assessmentId = this.data.assessment.id
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1
    let url
    const saved = await this._run(async assertCurrent => {
      const attempt = await request({ url: `/care/assessment-items/${item.id}/attempts`, method: 'POST', data: {
        ...(item.repeat_request ? { repeat_report_id: item.repeat_request.report_id } : {}),
        expected_item_version: item.version, protocol_id: item.protocol_id, protocol_schema_version: item.protocol_schema_version,
        config_digest: item.config_digest, performer_patient_id: item.kind === 'scale' ? null : this.data.patientId, respondent_kind: item.respondent_kind,
        confirmed: true, device, input: { method: device.device_type === 'phone' ? 'touch' : 'unknown' }, timing: { clock_source: 'Date.now', unit: 'ms', calibrated: false },
        practice: { completed: false, attempts: 0, exposure_count: 0 }, assistance: { provided: this.data.assistanceProvided, kind: this.data.assistanceProvided ? 'declared_by_user' : 'none' },
        recall_window: item.recall_window
      } })
      assertCurrent()
      const session = await request({ url: `/care/assessments/${assessmentId}` })
      assertCurrent()
      const savedItem = (session.items || []).find(row => row.id === item.id)
      if (!savedItem || !(savedItem.attempts || []).some(row => row.id === attempt.id && row.run_id === attempt.run_id)) throw new Error('新尝试尚未读取确认，请刷新本轮资料。')
      url = executionUrl(session, savedItem, attempt)
      return session
    }, '新尝试已保存，请完成实际作答后提交。')
    if (saved && url && this._current(lease, version)) wx.navigateTo({ url })
    return saved
  },
  resumeAttempt(event) {
    if (!this._active || this.data.busy || !isPatientSessionLeaseCurrent(this._entryLease) || !this.data.respondentConfirmed) return false
    const item = this.data.itemViews.find(row => row.id === Number(event.currentTarget.dataset.id) && row.canResume)
    if (!item || !this.data.assessment) return false
    const attempt = (item.attempts || []).find(row => row.id === item.repeat_request.continuing_attempt_id && row.execution_status === 'in_progress')
    if (!attempt) return false
    wx.navigateTo({ url: executionUrl(this.data.assessment, item, attempt) }); return true
  }
}, options => hasValidAnySession() || ensurePatientSession(options)))
