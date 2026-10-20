const { request } = require('../../utils/request')
const { registerPatientPage } = require('../../utils/patient-page')
const { hasValidPatientSession, capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const queue = require('../../utils/submission-queue')
const original = require('../../utils/federated-consent-original')
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
const LABELS = { profile: '基础资料', assessment: '评估与报告', tracking: '追踪记录', care: '任务与消息', imaging: '已有影像分析' }
const STATUS = { active: '当前有效', withdrawn: '已撤回', superseded: '被后续授权替代', pending: '待生效', denied: '当前授权校验未通过', expired: '已到期', revoked: '已撤销' }
const choices = values => original.SCOPES.map(value => ({ value, label: LABELS[value], checked: values.includes(value) }))
const blank = () => ({ patients: [], patientIndex: -1, patientId: 0, patientName: '', projectInput: '', project: null,
  records: [], previousProjects: [], scopes: [], scopeOptions: choices([]), expiry: '', acknowledged: false, pendingId: '', busy: false, errorText: '', statusText: '', notice: '' })
registerPatientPage({
  data: blank(),
  onLoad(options = {}) {
    this._actor = (wx.getStorageSync('current_user') || {}).id
    this._lease = capturePatientSessionLease(); this._active = true
    this._patientId = positive(options.patient_id) ? Number(options.patient_id) : 0
    this._projectId = positive(options.project_id) ? Number(options.project_id) : 0
    return this.reload()
  },
  onShow() { if (this._ended) return false; this._active = true; return this.reload() },
  onHide() { this._active = false; this._epoch = (this._epoch || 0) + 1; this._context = null; this.setData(blank()) },
  onUnload() { this._ended = true; this.onHide() },
  onPatientSessionEnded() { this._ended = true; this._patientId = 0; this._projectId = 0; this.onHide() },
  usable() { return !this._ended && this._active && hasValidPatientSession() && (wx.getStorageSync('current_user') || {}).id === this._actor && isPatientSessionLeaseCurrent(this._lease) },
  current(epoch) { return this.usable() && this._epoch === epoch },
  resetProject() { this._context = null; this.setData({ project: null, records: [], scopes: [], scopeOptions: choices([]), expiry: '', acknowledged: false, pendingId: '', notice: '', statusText: '' }) },
  pending() {
    const row = queue.pendingEntries().find(item => original.KINDS.includes(item.kind) && item.payload.patient_id === this.data.patientId && original.projectId(item) === this._projectId)
    this.setData({ pendingId: row ? row.id : '' })
  },
  async reload() {
    if (!this.usable() || this.data.busy) return false
    const epoch = this._epoch = (this._epoch || 0) + 1
    this.resetProject(); this.setData({ busy: true, patients: [], patientId: 0, patientName: '', previousProjects: [], errorText: '' })
    try {
      const context = await request({ url: '/identity/context' }); if (!this.current(epoch)) return false
      if (context.user_id !== this._actor || !Array.isArray(context.accessible_patients)) throw new Error('当前身份材料不一致，请重新登录。')
      const patients = context.accessible_patients.filter(row => positive(row.patient_id) && (row.access_kind === 'self' || row.access_kind === 'guardian' && row.guardian_status === 'verified'))
        .map(row => ({ ...row, label: `${row.display_name || '档案'} · ${row.patient_id} · ${row.access_kind === 'self' ? '本人' : '已核验监护'}` }))
      if (this._patientId && !patients.some(row => row.patient_id === this._patientId)) throw new Error('此档案不属于当前本人或有效监护身份。原件仍可到待同步记录按原编号查询。')
      if (!this._patientId && patients.length === 1) this._patientId = patients[0].patient_id
      const index = patients.findIndex(row => row.patient_id === this._patientId), selected = patients[index]
      this.setData({ patients, patientIndex: index, patientId: selected ? selected.patient_id : 0, patientName: selected ? selected.label : '', projectInput: this._projectId ? String(this._projectId) : '' })
      if (!selected) { this.setData({ busy: false, statusText: patients.length ? '请选择你本人或实际监护的档案。' : '暂无本人或有效监护档案。可进入待同步记录恢复原编号确认。' }); return false }
      const previous = await request({ url: `/patient/consents?patient_id=${selected.patient_id}` }); if (!this.current(epoch)) return false
      if (!Array.isArray(previous.items) || previous.items.some(row => row.patient_id !== selected.patient_id)) throw new Error('原授权材料与所选档案不一致。')
      const ids = [...new Set(previous.items.filter(row => row.purpose === 'research' && positive(row.project_id)).map(row => row.project_id))]
      this.setData({ previousProjects: ids.map(id => ({ id })) })
      if (this._projectId) await this.loadProject(epoch)
      if (this.current(epoch)) this.setData({ busy: false }); return true
    } catch (error) { if (this.current(epoch)) { this.resetProject(); this.setData({ busy: false, errorText: error.message || '未能读取当前档案。' }) } return false }
  },
  onPatientChange(event) {
    if (!this.usable() || this.data.busy) return false
    const row = this.data.patients[Number(event.detail.value)]; if (!row) return false
    this._epoch++; this._patientId = row.patient_id; this._projectId = 0; this.resetProject(); return this.reload()
  },
  onProjectInput(event) {
    if (!this.usable() || this.data.busy) return
    this._epoch++; this._projectId = 0; this.resetProject(); this.setData({ projectInput: event.detail.value, errorText: '' })
  },
  usePrevious(event) {
    if (!this.usable() || this.data.busy) return false
    const id = Number(event.currentTarget.dataset.id)
    if (!this.data.previousProjects.some(row => row.id === id)) return false
    this.setData({ projectInput: String(id) }); return this.readProject()
  },
  async readProject() {
    if (!this.usable() || this.data.busy || !this.data.patientId) return false
    const text = this.data.projectInput.trim()
    if (!/^[1-9]\d*$/.test(text) || !positive(text)) { this.resetProject(); this.setData({ errorText: '请填写机构提供的具体研究项目编号。' }); return false }
    this._projectId = Number(text); const epoch = this._epoch = (this._epoch || 0) + 1
    this.resetProject(); this.setData({ busy: true, errorText: '' })
    try { await this.loadProject(epoch); if (this.current(epoch)) this.setData({ busy: false }); return true }
    catch (error) { if (this.current(epoch)) { this.resetProject(); this.setData({ busy: false, errorText: error.message || '未能读取此项目。' }) } return false }
  },
  async loadProject(epoch) {
    const id = this._projectId, pid = this.data.patientId
    this.pending()
    const context = await request({ url: `/federated/projects/${id}/consent?patient_id=${pid}` }); if (!this.current(epoch)) return false
    if (context.patient_id !== pid || context.project && context.project.id !== id || !context.project || !Array.isArray(context.items) ||
        context.items.some(row => row.patient_id !== pid || row.project_id !== id || row.purpose !== 'research' || typeof row.effective_access !== 'boolean')) throw new Error('研究说明或授权与当前档案、项目不一致。')
    this._context = context
    this.setData({ project: context.project, notice: context.notice || '', records: context.items.map(row => ({ ...row,
      scopeLabel: (row.scope || []).map(key => LABELS[key] || key).join('、'),
      statusLabel: row.effective_access ? '当前有效' : STATUS[row.effective_status] || STATUS[row.status] || '当前无有效授权',
      canWithdraw: row.status === 'active', expiryLabel: row.expires_at || '未单独指定到期时间，仍受项目和身份有效期限制' })) })
    this.pending(); return true
  },
  onScopeChange(event) {
    if (!this.usable() || this.data.busy || !this._context) return
    const scopes = event.detail.value.filter(key => original.SCOPES.includes(key)); this.setData({ scopes, scopeOptions: choices(scopes), acknowledged: false })
  },
  onExpiryInput(event) { if (this.usable() && !this.data.busy) this.setData({ expiry: event.detail.value, acknowledged: false }) },
  onAcknowledged(event) { if (this.usable() && !this.data.busy) this.setData({ acknowledged: event.detail.value.includes('read') }) },
  async grant() {
    if (!this.usable() || this.data.busy || this.data.pendingId || !this._context || !this.data.scopes.length || !this.data.acknowledged) return false
    const expires = this.data.expiry.trim()
    if (expires && (!/(Z|[+-]\d{2}:\d{2})$/.test(expires) || !Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now())) { this.setData({ errorText: '到期时间须为含时区的未来时间，或留空。' }); return false }
    const payload = { patient_id: this.data.patientId, project_id: this._projectId, expected_project_revision: this._context.project.revision, purpose: 'research', scope: this.data.scopes.slice(), terms_version: 'W02-1', expires_at: expires || null }
    return this.submit('federated_consent', payload, `档案：${this.data.patientName}\n项目：${this.data.project.name}（${this._projectId}）\n项目审批版本：${payload.expected_project_revision}\n用途：${this.data.project.purpose}\n范围：${payload.scope.map(key => LABELS[key]).join('、')}\n到期：${expires || '未单独指定，仍受项目和身份有效期限制'}\n仅同意此项目；撤回无法抹掉已发布模型的全部影响。`)
  },
  withdraw(event) {
    if (!this.usable() || this.data.busy || this.data.pendingId || !this._context) return false
    const row = this.data.records.find(item => item.id === Number(event.currentTarget.dataset.id) && item.canWithdraw)
    if (!row) return false
    return this.submit('federated_consent_withdraw', { patient_id: this.data.patientId, consent_id: row.id, expected_revision: row.revision },
      `撤回档案 ${this.data.patientName} 在项目 ${this.data.project.name}（${this._projectId}）的授权 ${row.id}，原版本 ${row.revision}。撤回阻止后续处理，不能抹掉已发布模型的全部影响。`)
  },
  async submit(kind, body, content) {
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, errorText: '', statusText: '' })
    try {
      const agreed = await new Promise(resolve => wx.showModal({ title: kind === 'federated_consent' ? '明确授权此项研究' : '明确撤回此项授权', content, success: value => resolve(value.confirm === true), fail: () => resolve(false) }))
      if (!this.current(epoch)) return false
      if (!agreed) { this.setData({ busy: false }); return false }
      const id = `research-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
      const payload = { client_request_id: id, ...body }, route = `/federated/projects/${this._projectId}/consent${kind === 'federated_consent_withdraw' ? '/withdraw' : ''}`
      queue.enqueue({ id, kind, route, payload }); this.pending()
      const ack = await queue.syncQueuedAcknowledgement(id); if (!this.current(epoch)) return false
      this.setData({ busy: false }); this.pending()
      if (!ack) { this.setData({ statusText: '操作原件已保存在本机，尚未得到准确确认。请按原编号查询，查询未找到不会自动再次授权。' }); return false }
      // An old ACK is never presented as a current grant.
      this.setData({ statusText: '原操作已确认，正在重新读取当前有效状态。' }); return this.reload()
    } catch (error) { if (this.current(epoch)) this.setData({ busy: false, errorText: error.message || '操作未完成，已保存的原件请按原编号查询。' }); return false }
  },
  async queryPending() {
    if (!this.usable() || this.data.busy || !this.data.pendingId) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, errorText: '' })
    const ack = await queue.queryQueuedAcknowledgement(this.data.pendingId); if (!this.current(epoch)) return false
    this.setData({ busy: false }); this.pending()
    if (ack) return this.reload()
    this.setData({ statusText: '尚未核对到原操作确认。原件继续保留；可到原件恢复页查询和核对。' }); return false
  },
  openRecovery() { if (this.usable()) wx.navigateTo({ url: '/pages/submission-queue/index' }) }
})
