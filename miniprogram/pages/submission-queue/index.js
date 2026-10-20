const { protectPatientPage } = require('../../utils/patient-page')
const { hasValidAnySession } = require('../../utils/role-session')
const { ensurePatientSession, capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const queue = require('../../utils/submission-queue')
const federatedConsent = require('../../utils/federated-consent-original')
const FEDERATED = { federated_consent: '已确认的具体研究授权', federated_consent_withdraw: '已确认的具体研究撤回' }
const LABELS = { pending_sync: '待同步', authorization_blocked: '授权已失效', conflict_blocked: '内容或任务冲突', ack_unverified: '提交确认需核对', archived_unconfirmed: '本机已归档，服务器仍未确认' }
const TASKS = { reaction: '反应抑制', stroop: '颜色干扰', flanker: '箭头抗干扰', nback: '两步位置记忆', trail: '连线', digit: '数字广度', ASRS: '成人量表', SNAP_IV: '儿童观察量表' }
const TRANSFERS = { transfer_request: '已确认交接请求', transfer_decision: '已确认交接决定', transfer_work_action: '已确认继任处理' }
const AGENTS = { agent_run: '助手请求原件', artifact_decision: '已核对草稿的采纳或拒绝原件' }
const REVIEWS = { review_draft: '已确认私人审核草稿', review_publication: '已确认医生发布', review_question: '已确认具体补问', clarification_reply: '已确认补问答复', plan_publication: '已确认计划发布', plan_received: '已确认计划收到', cycle_review: '已确认阶段复核或下一轮', imaging_report: '已确认医生影像报告发布' }

Page(protectPatientPage({
  data: { entries: [], busy: false, errorText: '', statusText: '', originalText: '', fallbackUrl: '/pages/home/index' },
  onLoad() {
    this._active = true; this._pageLease = capturePatientSessionLease()
    const user = wx.getStorageSync('current_user') || {}
    this._pageActor = { id: user.id, role: user.role }
    this.setData({ fallbackUrl: user.role === 'researcher' ? '/pages/doctor-home/index' : '/pages/home/index' })
    this.refresh()
  },
  onShow() { if (this._ended) return false; this._active = true; return this.refresh() },
  onHide() { this._active = false; this._version = (this._version || 0) + 1; this.setData({ entries: [], busy: false, errorText: '', statusText: '', originalText: '' }) },
  onUnload() { this.onHide() },
  onPatientSessionEnded() { this._ended = true; this.onHide() },
  _allowed() {
    if (this._ended || !this._active || !hasValidAnySession() || !isPatientSessionLeaseCurrent(this._pageLease)) return false
    const user = wx.getStorageSync('current_user') || {}
    return this._pageActor && user.id === this._pageActor.id && user.role === this._pageActor.role
  },
  refresh() {
    if (!this._allowed()) { this.setData({ entries: [], busy: false, errorText: '', statusText: '', originalText: '' }); return false }
    if (this.data.busy) return false
    try {
      const entries = queue.allEntries().map(item => {
        const content = item.payload.content || item.payload
        return { id: item.id, title: FEDERATED[item.kind] || AGENTS[item.kind] || REVIEWS[item.kind] || TRANSFERS[item.kind] || (item.kind === 'service_coverage' ? '已确认覆盖配置' : item.kind === 'attention_action' ? '已确认关注处理' : item.kind === 'shared_message' ? '已确认共享消息' : item.kind === 'cycle_create' ? '自助记录周期' : item.kind === 'cycle_daily' ? '每日记录' : TASKS[content.scale_type || content.test_type] || '评估记录'),
          sourceLabel: item.kind === 'imaging_report' ? `档案 ${item.payload.patient_id} · 影像分析 ${item.payload.prediction_id} · 原报告版本 ${item.payload.expected_previous_version}` : item.kind === 'cycle_review' ? `档案 ${item.payload.patient_id} · 实际周期 ${item.payload.cycle_id} · 原阶段材料` : AGENTS[item.kind] ? `档案 ${item.payload.patient_id} · 助手原请求` : REVIEWS[item.kind] ? `档案 ${item.payload.patient_id} · 第 ${item.payload.assessment_id} 轮 · 原输入版本 ${item.payload.expected_assessment_version}` : TRANSFERS[item.kind] ? `档案 ${item.payload.patient_id} · ${item.kind === 'transfer_request' ? '接收关系 ' + item.payload.receiving_relationship_id + ' · ' + item.payload.sources.length + ' 项' : item.kind === 'transfer_decision' ? '交接 ' + item.payload.transfer_id : '继任事项 ' + item.payload.work_item_id}` : item.kind === 'service_coverage' ? `机构 ${item.payload.institution_id} · 医生账号 ${item.payload.doctor_user_id} · 原版本 ${item.payload.expected_previous_version}` : item.kind === 'attention_action' ? `档案 ${item.payload.patient_id} · 关注事项 ${item.payload.attention_id} · 原版本 ${item.payload.expected_version}` : item.kind === 'shared_message' ? `档案 ${item.payload.patient_id} · 共享关系 ${item.payload.relationship_id}` : item.kind === 'cycle_create' ? `${item.payload.start_date} 至 ${item.payload.end_date}` : item.kind === 'cycle_daily' ? `周期 ${item.payload.cycle_id} · ${item.payload.record_date}` : item.kind === 'assessment' ? `第 ${item.payload.assessment_id} 轮` : '历史测试',
          ...(FEDERATED[item.kind] ? { sourceLabel: `档案 ${item.payload.patient_id} · 具体研究项目 ${federatedConsent.projectId(item)}${item.kind === 'federated_consent_withdraw' ? ' · 原授权 ' + item.payload.consent_id + ' · 原版本 ' + item.payload.expected_revision : ''}`, researchRoute: `/pages/research-consent/index?patient_id=${item.payload.patient_id}&project_id=${federatedConsent.projectId(item)}` } : {}),
          statusLabel: LABELS[item.status] || '待核对', canRetry: item.status !== 'archived_unconfirmed', canArchive: queue.canArchive(item),
          canViewOriginal: ['attention_action', 'service_coverage', ...Object.keys(FEDERATED), ...Object.keys(TRANSFERS), ...Object.keys(REVIEWS), ...Object.keys(AGENTS)].includes(item.kind), canQuery: ['assessment', 'cycle_daily', 'shared_message', 'attention_action', 'service_coverage', ...Object.keys(FEDERATED), ...Object.keys(TRANSFERS), ...Object.keys(REVIEWS), ...Object.keys(AGENTS)].includes(item.kind) }
      })
      this.setData({ entries, errorText: '' }); return true
    } catch (error) { this.setData({ entries: [], errorText: error.message || '待同步内容读取失败，请重试。' }); return false }
  },
  async _synchronize(event, queryOnly) {
    if (!this._allowed() || this.data.busy) return false
    const id = event.currentTarget.dataset.id
    if (!this.data.entries.some(item => item.id === id && (queryOnly ? item.canQuery : item.canRetry))) return false
    const lease = capturePatientSessionLease()
    const version = (this._version || 0) + 1; this._version = version
    this.setData({ busy: true, statusText: '', errorText: '' })
    const acknowledged = await (queryOnly ? queue.queryQueuedStatus(id) : queue.syncQueued(id))
    if (!this._allowed() || this._version !== version || !isPatientSessionLeaseCurrent(lease)) return false
    this.setData({ busy: false, statusText: acknowledged ? '服务器已确认这份记录，其他待同步内容保留。' : '尚未获得提交确认，请根据记录状态核对或稍后重试。' })
    this.refresh(); return acknowledged
  },
  retry(event) { return this._synchronize(event, false) },
  queryStatus(event) { return this._synchronize(event, true) },
  viewOriginal(event) {
    if (!this._allowed() || this.data.busy) return false
    const id = event.currentTarget.dataset.id
    try {
      const item = queue.allEntries().find(row => row.id === id && ['attention_action', 'service_coverage', ...Object.keys(FEDERATED), ...Object.keys(TRANSFERS), ...Object.keys(REVIEWS), ...Object.keys(AGENTS)].includes(row.kind))
      if (!item) return false
      this.setData({ originalText: JSON.stringify({ original_id: item.id, route: item.route, local_status: item.status, payload: item.payload,
        ...(item.expected_review ? { original_review: item.expected_review } : {}) }, null, 2) }); return true
    } catch (failure) { this.setData({ originalText: '', errorText: failure.message || '本机原件读取失败。' }); return false }
  },
  async archive(event) {
    if (!this._allowed() || this.data.busy) return false
    const id = event.currentTarget.dataset.id, lease = capturePatientSessionLease(), version = (this._version || 0) + 1
    this._version = version; this.setData({ busy: true, statusText: '', errorText: '', originalText: '' })
    try {
      if (!queue.canArchive(queue.allEntries().find(item => item.id === id))) throw new Error('原件状态已变化，请先查询原编号。')
      const agreed = await new Promise(resolve => wx.showModal({ title: '保留原件并重新核对',
        content: `原编号：${id}\n服务器曾拒绝提交，最近查询未找到。原件会保留在本机，停止重发；这不表示已撤销服务器请求。返回业务页后须重新读取、选择并确认。`,
        success: result => resolve(result.confirm === true), fail: () => resolve(false) }))
      if (!this._allowed() || this._version !== version || !isPatientSessionLeaseCurrent(lease)) return false
      if (!agreed) { this.setData({ busy: false }); return false }
      if (!queue.archiveQueued(id, { confirmed: true })) throw new Error('原件状态已变化，请重新核对。')
      this.setData({ busy: false, statusText: '这份原件已在本机归档保留，仍可查询服务器确认。其他原件保留。' }); this.refresh(); return true
    } catch (failure) {
      if (this._allowed() && this._version === version && isPatientSessionLeaseCurrent(lease)) this.setData({ busy: false, errorText: failure.message || '原件归档失败，请重试。' })
      return false
    }
  },
  openResearch(event) {
    if (!this._allowed() || this.data.busy) return false
    const row = this.data.entries.find(item => item.id === event.currentTarget.dataset.id && item.researchRoute)
    if (row) wx.navigateTo({ url: row.researchRoute })
    return Boolean(row)
  },
  openPrivacy() {
    if (!this._allowed()) return false
    wx.navigateTo({ url: this._pageActor.role === 'researcher' ? '/pages/doctor-guide-settings/index' : '/pages/privacy-settings/index' })
    return true
  }
}, options => hasValidAnySession() || ensurePatientSession(options)))
