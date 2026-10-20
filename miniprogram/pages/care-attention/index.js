const { request } = require('../../utils/request')
const { protectPatientPage } = require('../../utils/patient-page')
const { hasValidAnySession } = require('../../utils/role-session')
const { ensurePatientSession, capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const queue = require('../../utils/submission-queue')
const { coverageText } = require('../../utils/service-coverage-display')
const { describeOverdue } = require('../../utils/attention-observations')

const positive = value => Number.isInteger(Number(value)) && Number(value) > 0
const LABELS = { open: '待查看', acknowledged: '已确认关注', in_progress: '旧版处理中', resolved: '已解决', closed_with_reason: '已说明原因关闭', closed: '旧版已关闭', suspended: '已暂停',
  submitted: '已提交', valid: '有效', limited: '有局限', invalid: '无效', pending_review: '待医生验收',
  accepted: '医生已验收', not_required: '无需医生验收', needs_repeat: '需要重测', rejected: '已退回' }
const REASONS = { execution_interrupted: '执行过程有中断', unknown_input: '输入方式未确认', unknown_device: '设备资料未确认',
  unknown_clock: '计时信息未确认', practice_evidence_incomplete: '练习记录不完整', practice_not_passed: '练习未通过',
  assistance_requires_review: '有协助操作，需要结合情况查看', high_omissions: '漏答较多', high_false_starts: '提前点击较多',
  low_accuracy: '正确率较低', no_correct_trials: '没有正确作答记录', nonpositive_response_time: '部分反应时间需核对' }
const AUTHORITY_REASONS = { doctor_qualification_expired: '医生资格有效期已到', institution_membership_expired: '机构成员资格有效期已到',
  guardian_relationship_expired: '监护关系有效期已到', patient_identity_expired: '档案访问身份有效期已到',
  clinical_relationship_expired: '医患关系有效期已到', purpose_consent_expired: '用途同意有效期已到', account_disabled: '原账号已停用',
  original_account_unavailable: '原账号不可用', original_authority_invalid: '原身份或授权不可用' }
const label = value => LABELS[value] || '状态待确认'
const message = failure => failure && failure.statusCode === 403 ? '当前授权无法读取，请核对身份或共享关系。' : '资料读取失败或不一致，请刷新后重试。'
const ACTION_LABELS = { acknowledge: '确认关注', resolve: '标记已解决', close_with_reason: '说明原因关闭' }
const ACTION_STATUS = { acknowledge: 'acknowledged', resolve: 'resolved', close_with_reason: 'closed_with_reason' }
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const instant = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
const timeLabel = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + '（北京时间）'
const processingBlank = () => ({ processing: null, actionHistory: [], processingReason: '', pendingId: '', pendingStatus: '', canArchivePending: false, statusText: '' })

Page(protectPatientPage({
  data: { role: 'patient', patientId: 0, fallbackUrl: '/pages/home/index', title: '关注事项', items: [],
    evidence: null, loading: false, busy: false, errorText: '', coverageText: '', ...processingBlank() },
  onLoad(options = {}) {
    this._active = true
    this._pageLease = capturePatientSessionLease()
    const user = wx.getStorageSync('current_user') || {}
    this._owner = { id: user.id, role: user.role }
    this._invalidContext = options.patient_id !== undefined && !positive(options.patient_id)
    this.setData({ patientId: positive(options.patient_id) ? Number(options.patient_id) : 0 })
    return this.reload()
  },
  onShow() { if (this._ended) return false; this._active = true; return this.reload() },
  openTransfers() { if (!this._usable()) return false; wx.navigateTo({ url: '/pages/responsibility-transfers/index' + (this.data.patientId ? '?patient_id=' + this.data.patientId : '') }); return true },
  openTransferredWork() { if (!this._usable()) return false; wx.navigateTo({ url: '/pages/transferred-work/index' + (this.data.patientId ? '?patient_id=' + this.data.patientId : '') }); return true },
  onHide() {
    this._active = false; this._version = (this._version || 0) + 1
    this._detail = null; this._processingRow = null
    this.setData({ items: [], evidence: null, loading: false, busy: false, coverageText: '', errorText: '', ...processingBlank() })
  },
  onUnload() { this._ended = true; this.onHide() },
  onPatientSessionEnded() { this._ended = true; this.onHide() },
  _usable() {
    if (this._ended || !this._active) return false
    const user = wx.getStorageSync('current_user') || {}
    if (!hasValidAnySession() || !isPatientSessionLeaseCurrent(this._pageLease) || !this._owner ||
      user.id !== this._owner.id || user.role !== this._owner.role) { this.onPatientSessionEnded(); return false }
    return true
  },
  _current(lease,version) { return this._usable() && this._version === version && isPatientSessionLeaseCurrent(lease) },
  async reload() {
    if (!this._usable() || this.data.loading || this.data.busy) return false
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1
    this._version = version
    this._detail = null; this._processingRow = null
    this.setData({ loading: true, errorText: '', evidence: null, items: [], ...processingBlank() })
    try {
      if (this._invalidContext || !hasValidAnySession()) throw new Error('invalid context')
      const user = wx.getStorageSync('current_user') || {}, doctor = user.role === 'researcher'
      let patientId = this.data.patientId
      this.setData({ role: user.role, title: doctor ? '医生工作待办' : '关注事项', fallbackUrl: doctor ? '/pages/doctor-home/index' : '/pages/home/index' })
      if (!doctor) {
        const context = await request({ url: '/identity/context' })
        if (!this._current(lease,version)) return false
        const patients = context.accessible_patients || []
        const patient = patientId ? patients.find(row => row.patient_id === patientId) : patients[0]
        if (!patient || !positive(patient.patient_id)) throw new Error('patient context unavailable')
        patientId = patient.patient_id
      }
      const result = await request({ url: doctor ? '/care/doctor/work_queue' : `/care/patient/attention?patient_id=${patientId}` })
      if (!this._current(lease,version)) return false
      if (!result || !Array.isArray(result.items)) throw new Error('missing actual list')
      const items = result.items.map(row => {
        if (!positive(row.id) || !positive(row.patient_id) || !positive(row.assessment_id) ||
          (doctor ? row.owner_kind !== 'doctor' || row.responsible_doctor_id !== user.id : row.patient_id !== patientId)) throw new Error('wrong owner')
        return { ...row, title: row.kind === 'evidence_review' ? '材料已齐，等待医生查看' : '本次测试质量有局限，请查看记录',
          coverageText: coverageText(row.response_coverage), deadlineText: row.expected_response_at ? instant(row.expected_response_at) ? timeLabel(row.expected_response_at) : '截止时间需核对' : '未配置',
          overdueText: describeOverdue(row,timeLabel),
          currentCoverageText: row.current_service_coverage ? row.current_service_coverage.status === 'configured' && row.response_coverage && row.response_coverage.status === 'configured' &&
            row.current_service_coverage.coverage.id === row.response_coverage.coverage.id && row.current_service_coverage.coverage.version === row.response_coverage.coverage.version
            ? '与创建时配置相同，原窗口保持不变。' : coverageText(row.current_service_coverage) : '',
          suspensionObservationText: row.suspension_observation && row.suspension_observation.human_action === false &&
            row.suspension_observation.system_principal === 'care_authority_reconciler' && instant(row.suspension_observation.observed_at)
            ? `后台核对时间：${timeLabel(row.suspension_observation.observed_at)}；${AUTHORITY_REASONS[row.suspension_observation.reason_code] || '原身份或授权不可用'}。` : '',
          statusLabel: label(row.status), reasonText: (row.quality_reasons || []).map(value => REASONS[value] || '请查看原件中的质量说明').join('；'),
          canReadEvidence: typeof row.submission_id === 'string' && (row.allowed_actions || []).includes('read_evidence') }
      })
      this.setData({ patientId, items, loading: false, coverageText: doctor ? coverageText(result.service_coverage) :
        items.some(row => row.response_coverage && row.response_coverage.status === 'configured') ? '各事项分别显示创建时覆盖与当前配置；当前配置不会改写原窗口。通知不表示已经处理。' : coverageText(null) })
      return true
    } catch (failure) {
      if (!this._current(lease,version)) return false
      this.setData({ loading: false, items: [], evidence: null, errorText: message(failure) })
      return false
    }
  },
  async readEvidence(event) {
    const row = this.data.items.find(value => value.id === Number(event.currentTarget.dataset.id))
    if (!row || !row.canReadEvidence || this.data.loading || this.data.busy || !this._usable()) return false
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1
    this._version = version
    this.setData({ busy: true, evidence: null, errorText: '' })
    try {
      const value = await request({ url: `/care/submissions/${encodeURIComponent(row.submission_id)}/evidence` })
      if (!this._current(lease,version)) return false
      if (!value || value.submission_id !== row.submission_id || !value.context || value.context.patient_id !== row.patient_id ||
        value.context.assessment_id !== row.assessment_id || !value.server_result || value.server_result.legacy !== false) throw new Error('wrong original evidence')
      const result = value.server_result, raw = result.kind === 'cognitive' && result.result_json && result.result_json.raw_result
      const trials = result.kind === 'cognitive' && result.result_json && result.result_json.trials
      const scoreText = result.kind === 'scale' && typeof result.total_score === 'number' ? `量表总分 ${result.total_score}`
        : raw && typeof raw.accuracy === 'number' ? `准确率 ${raw.accuracy}%` : '请结合本轮原始记录查看'
      this.setData({ busy: false, evidence: { qualityLabel: label(value.ack && value.ack.quality_status),
        acceptanceLabel: label(value.ack && value.ack.acceptance_status), scoreText,
        trialCount: Array.isArray(trials) ? trials.length : null } })
      return true
    } catch (failure) {
      if (!this._current(lease,version)) return false
      this.setData({ busy: false, evidence: null, errorText: message(failure) }); return false
    }
  },
  async openProcessing(event) {
    const row = this.data.items.find(value => value.id === Number(event.currentTarget.dataset.id))
    if (!row || this.data.loading || this.data.busy || !this._usable()) return false
    return this._loadProcessing(row)
  },
  async _loadProcessing(row) {
    if (!this._usable()) return false
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1
    this._version = version; this._detail = null; this._processingRow = null
    this.setData({ busy: true, errorText: '', ...processingBlank() })
    try {
      const detail = await request({ url: `/care/attention/${row.id}` })
      if (!this._current(lease, version)) return false
      const actual = detail && detail.attention, actions = detail && detail.allowed_actions
      if (!actual || actual.id !== row.id || actual.patient_id !== row.patient_id || actual.assessment_id !== row.assessment_id ||
        actual.owner_kind !== row.owner_kind || actual.responsible_doctor_id !== row.responsible_doctor_id || !positive(actual.version) ||
        !Array.isArray(actions) || actions.some(value => !Object.prototype.hasOwnProperty.call(ACTION_LABELS, value)) || new Set(actions).size !== actions.length ||
        (actions.length ? typeof detail.action_context !== 'string' || !digest(detail.action_context_digest) : detail.action_context !== null || detail.action_context_digest !== null)) throw new Error('inconsistent action context')
      const history = await request({ url: `/care/attention/${row.id}/history` })
      if (!this._current(lease, version)) return false
      if (!history || !Array.isArray(history.items) || history.items.some(value => !value || !positive(value.action_id) ||
        value.attention_id !== row.id || value.patient_id !== row.patient_id || !positive(value.actor_user_id) ||
        !positive(value.expected_version) || value.version !== value.expected_version + 1 ||
        !Object.prototype.hasOwnProperty.call(ACTION_LABELS, value.action) || value.status !== ACTION_STATUS[value.action] ||
        value.submission_status !== 'committed' || value.legacy !== false || value.confirmed !== true || !instant(value.occurred_at) ||
        (value.reason !== null && typeof value.reason !== 'string') || (value.action !== 'acknowledge' && !(value.reason || '').trim()))) throw new Error('inconsistent action history')
      this._detail = detail; this._processingRow = { ...row, ...actual }
      const pending = queue.pendingEntries().find(value => value.kind === 'attention_action' && value.payload.attention_id === row.id)
      const items = this.data.items.filter(value => value.id !== actual.id || this._owner.role !== 'researcher' ||
        ['open', 'acknowledged', 'in_progress'].includes(actual.status)).map(value => value.id === actual.id ?
        { ...value, status: actual.status, version: actual.version, statusLabel: label(actual.status) } : value)
      this.setData({ busy: false, items, processing: { id: actual.id, version: actual.version, statusLabel: label(actual.status),
        canAcknowledge: !pending && actions.includes('acknowledge'), canResolve: !pending && actions.includes('resolve'),
        canClose: !pending && actions.includes('close_with_reason'), readOnly: !pending && actions.length === 0 },
        actionHistory: history.items.map(value => ({ ...value, actorLabel: `账号 ${value.actor_user_id}`, actionLabel: ACTION_LABELS[value.action], timeLabel: timeLabel(value.occurred_at) })),
        pendingId: pending ? pending.id : '', pendingStatus: pending ? pending.status : '', canArchivePending: queue.canArchive(pending), processingReason: pending ? pending.payload.reason || '' : '',
        statusText: pending ? '原处理记录仍保存在本机，尚待核对服务器确认；不会改用新权限或新版本。' : '' })
      return true
    } catch (failure) {
      if (this._current(lease, version)) this.setData({ busy: false, errorText: message(failure), ...processingBlank() })
      return false
    }
  },
  onReasonInput(event) {
    if (this._usable() && this.data.processing && !this.data.busy && !this.data.pendingId) this.setData({ processingReason: event.detail.value })
  },
  async submitAction(event) {
    if (!this._usable() || this.data.busy || this.data.loading || !this._detail || this.data.pendingId) return false
    const action = event.currentTarget.dataset.action, row = this._processingRow, detail = this._detail
    if (!row || Number(event.currentTarget.dataset.id) !== row.id || !detail.allowed_actions.includes(action)) return false
    const input = this.data.processingReason, reason = typeof input === 'string' && input.trim() ? input : null
    if ((action !== 'acknowledge' && reason === null) || (reason && reason.length > 2000)) {
      this.setData({ errorText: '请填写实际处理或关闭说明，最多 2000 字。' }); return false
    }
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1
    this._version = version; this.setData({ busy: true, errorText: '', statusText: '' })
    try {
      const confirmed = await new Promise(resolve => wx.showModal({ title: ACTION_LABELS[action],
        content: `确认以当前账号处理事项 ${row.id}（版本 ${detail.attention.version}）？${reason ? '\n说明：' + reason : ''}\n此操作不表示医生专业验收或诊断。`,
        confirmText: '确认提交', success: value => resolve(value.confirm === true), fail: () => resolve(false) }))
      if (!this._current(lease, version)) return false
      if (!confirmed) { this.setData({ busy: false }); return false }
      const id = `attention-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
      queue.enqueue({ id, kind: 'attention_action', route: '/care/attention-actions', expected_context_digest: detail.action_context_digest,
        payload: { patient_id: row.patient_id, attention_id: row.id, client_action_id: id, expected_version: detail.attention.version,
          action, reason, action_context: detail.action_context, confirmed: true } })
      this.setData({ pendingId: id, pendingStatus: 'pending_sync', statusText: '已保存本机原件，正在核对服务器提交。' })
      const ack = await queue.syncQueuedAcknowledgement(id)
      if (!this._current(lease, version)) return false
      this.setData({ busy: false })
      if (ack) {
        const readVersion = this._version + 1, refreshed = await this._loadProcessing(row)
        if (this._current(lease, readVersion)) this.setData({ statusText: refreshed ? '服务器已确认本次处理，实际处理历史已重新读取。' : '服务器已确认本次处理；详情暂未读取，请刷新核对。' })
        return true
      }
      this._showPending(id); return false
    } catch (failure) {
      if (this._current(lease, version)) this.setData({ busy: false, errorText: /^QUEUE_/.test(failure.code || '') ? failure.message : '处理尚未获得确认，请保留本机原件并核对。' })
      return false
    }
  },
  _showPending(id) {
    const pending = queue.pendingEntries().find(value => value.id === id)
    this.setData({ pendingId: pending ? id : '', pendingStatus: pending ? pending.status : '', canArchivePending: queue.canArchive(pending),
      statusText: pending ? '原处理记录已保存在本机，服务器尚未确认。可查询原编号；授权或版本冲突时先核对。' : '本机没有这份原件，请重新读取服务器历史。' })
  },
  async _recoverAction(queryOnly) {
    if (!this._usable() || this.data.busy || !this.data.pendingId) return false
    if (!queryOnly && ['authorization_blocked', 'conflict_blocked'].includes(this.data.pendingStatus)) return false
    const id = this.data.pendingId, row = this._processingRow, lease = capturePatientSessionLease(), version = (this._version || 0) + 1
    this._version = version; this.setData({ busy: true, errorText: '' })
    const confirmed = await (queryOnly ? queue.queryQueuedStatus(id) : queue.syncQueued(id))
    if (!this._current(lease, version)) return false
    this.setData({ busy: false })
    if (confirmed) {
      const readVersion = this._version + 1, refreshed = await this._loadProcessing(row)
      if (this._current(lease, readVersion)) this.setData({ statusText: refreshed ? '服务器已确认原编号记录，实际历史已重新读取。' : '服务器已确认原编号记录；详情暂未读取，请刷新核对。' })
    }
    else this._showPending(id)
    return Boolean(confirmed)
  },
  retryAction() { return this._recoverAction(false) },
  queryAction() { return this._recoverAction(true) },
  async archivePending() {
    if (!this._usable() || this.data.busy || this.data.loading || !this.data.pendingId) return false
    const id = this.data.pendingId, lease = capturePatientSessionLease(), version = (this._version || 0) + 1
    this._version = version; this.setData({ busy: true, errorText: '' })
    try {
      if (!queue.canArchive(queue.pendingEntries().find(row => row.id === id))) throw new Error('请先查询原编号；只有明确拒绝且最近查询未找到的原件可以归档。')
      const confirmed = await new Promise(resolve => wx.showModal({ title: '保留原处理并重新核对',
        content: `原编号：${id}\n服务器曾拒绝本次提交，最近原编号查询未找到。原件会保留在本机并停止重发；这不表示已撤销服务器请求。请重新打开实际事项、读取当前状态并确认新处理。`,
        success: result => resolve(result.confirm === true), fail: () => resolve(false) }))
      if (!this._current(lease, version)) return false
      if (!confirmed) { this.setData({ busy: false }); return false }
      if (!queue.archiveQueued(id, { confirmed: true })) throw new Error('原件归档未保存或状态已变化，请重新查询核对。')
      this._detail = null; this._processingRow = null; this.setData({ ...processingBlank(), busy: false })
      const readVersion = this._version + 1, refreshed = await this.reload()
      if (this._current(lease, readVersion)) this.setData({ statusText: refreshed ? '原处理已在本机归档保留，仍可查询原编号。请重新打开当前事项并确认。' : '原处理已在本机归档保留；事项读取失败，请刷新后重新打开。' })
      return true
    } catch (failure) {
      if (this._current(lease, version)) this.setData({ busy: false, errorText: failure.message || '原处理归档失败，请保留原件。' })
      return false
    }
  },
  openRecovery() { if (this._usable()) wx.navigateTo({ url: '/pages/submission-queue/index' }) },
  openAssessment(event) {
    const row = this.data.items.find(value => value.id === Number(event.currentTarget.dataset.id))
    if (!row || this.data.loading || this.data.busy || !this._usable()) return false
    wx.navigateTo({ url: `/pages/assessments/index?patient_id=${row.patient_id}&assessment_id=${row.assessment_id}` })
    return true
  }
}, options => hasValidAnySession() || ensurePatientSession(options)))
