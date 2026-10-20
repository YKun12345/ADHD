const { request } = require('../../utils/request')
const { protectPatientPage } = require('../../utils/patient-page')
const { hasValidAnySession } = require('../../utils/role-session')
const { ensurePatientSession, capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const queue = require('../../utils/submission-queue')
const positive = value => Number.isInteger(value) && value > 0
const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const periodText = values => values.map(value => `${days[value.weekday]} ${value.start}-${value.end}`).join('\n')
const blank = () => ({ doctors: [], doctorId: 0, doctorIndex: -1, doctorLabel: '请选择实际医生', institution: '',
  history: [], periodsText: '', responseMinutes: '', processReference: '', instructions: '', pendingId: '', pendingStatus: '', canArchivePending: false,
  canConfigure: false, currentText: '', errorText: '', statusText: '' })
const parsePeriods = text => text.trim().split(/\r?\n/).map(line => {
  const match = line.trim().match(/^周([一二三四五六日])\s+((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)$/)
  if (!match || match[2] >= match[3]) throw new Error('每行请按“周一 09:00-12:00”填写实际工作时段。')
  return { weekday: '一二三四五六日'.indexOf(match[1]), start: match[2], end: match[3] }
})
function verifyVersion(row, doctorId, institution) {
  if (!row || !positive(row.id) || row.doctor_user_id !== doctorId || row.institution_id !== institution || !positive(row.version) ||
    row.timezone !== 'Asia/Shanghai' || !Array.isArray(row.working_periods) || !positive(row.expected_response_working_minutes) ||
    typeof row.approved_process_reference !== 'string' || typeof row.escalation_instructions !== 'string' ||
    typeof row.effective_from !== 'string' || !Number.isFinite(Date.parse(row.effective_from)) || row.submission_status !== 'committed' || row.legacy !== false) throw new Error('配置版本归属或来源不一致。')
  return { ...row, periodsLabel: periodText(row.working_periods) }
}

Page(protectPatientPage({
  data: { ...blank(), loading: false, busy: false },
  onLoad() {
    this._active = true; this._lease = capturePatientSessionLease()
    const user = wx.getStorageSync('current_user') || {}; this._actor = { id: user.id, role: user.role }
    return this.reload()
  },
  onShow() { if (this._ended) return false; this._active = true; return this.reload() },
  onHide() { this._active = false; this._version = (this._version || 0) + 1; this._original = null; this.setData({ ...blank(), loading: false, busy: false }) },
  onUnload() { this._ended = true; this.onHide() },
  onPatientSessionEnded() { this._ended = true; this.onHide() },
  _usable() {
    if (this._ended || !this._active) return false
    const user = wx.getStorageSync('current_user') || {}
    if (!hasValidAnySession() || !isPatientSessionLeaseCurrent(this._lease) || !this._actor || user.id !== this._actor.id || user.role !== this._actor.role) {
      this.onPatientSessionEnded(); return false
    }
    return true
  },
  _current(version) { return this._usable() && this._version === version },
  async reload() {
    if (!this._usable() || this.data.busy || this.data.loading) return false
    const version = this._version = (this._version || 0) + 1
    this._original = null; this.setData({ ...blank(), loading: true })
    try {
      let listed
      try { listed = await request({ url: '/identity/service-coverage/doctors' }) }
      catch (failure) { if (failure.statusCode !== 403) throw failure }
      if (!this._current(version)) return false
      if (listed) {
        if (!Array.isArray(listed.items) || listed.items.some(row => !positive(row.doctor_user_id) || typeof row.institution_id !== 'string' || !row.institution_id)) throw new Error('机构审核范围不一致。')
        this.setData({ loading: false, canConfigure: true, doctors: listed.items.map(row => ({ ...row, label: `机构 ${row.institution_id} · 医生账号 ${row.doctor_user_id}` })) })
        return true
      }
      const current = await request({ url: '/care/doctor/service-coverage' })
      if (!this._current(version)) return false
      if (!current || !['configured', 'not_configured'].includes(current.status)) throw new Error('服务覆盖状态不一致。')
      const coverage = current.coverage
      if (current.status === 'configured') {
        const row = verifyVersion(coverage, this._actor.id, coverage.institution_id)
        this.setData({ history: [row], currentText: '已读取本人实际覆盖配置；这份记录不表示机构上线准入已核验。' })
      } else this.setData({ currentText: '服务覆盖未配置或原配置权限已变化；没有全天响应或紧急处置承诺。' })
      this.setData({ loading: false }); return true
    } catch (failure) {
      if (this._current(version)) this.setData({ ...blank(), loading: false, errorText: failure.statusCode === 403 ? '需要实际医生资格或本机构审核权限。' : '覆盖配置读取失败或不一致，请重试。' })
      return false
    }
  },
  async selectDoctor(event) {
    if (!this._usable() || !this.data.canConfigure || this.data.loading || this.data.busy) return false
    const index = Number(event.detail.value), row = this.data.doctors[index]
    if (!Number.isInteger(index) || !row) return false
    this.setData({ doctorId: row.doctor_user_id, doctorIndex: index, doctorLabel: row.label, institution: row.institution_id })
    return this._readVersions()
  },
  async _readVersions() {
    if (!this._usable() || !this.data.doctorId) return false
    const version = this._version = (this._version || 0) + 1, doctorId = this.data.doctorId, institution = this.data.institution
    this._original = null; this.setData({ busy: true, history: [], errorText: '', statusText: '', pendingId: '', canArchivePending: false })
    try {
      const response = await request({ url: `/identity/service-coverage/${doctorId}/versions?institution_id=${encodeURIComponent(institution)}` })
      if (!this._current(version)) return false
      if (!response || !Array.isArray(response.items) || typeof response.configuration_context !== 'string' || !/^[a-f0-9]{64}$/.test(response.configuration_context_digest)) throw new Error('missing original authority')
      const history = response.items.map(row => verifyVersion(row, doctorId, institution))
      if (history.some((row, index) => row.version !== index + 1)) throw new Error('inconsistent version history')
      this._original = { context: response.configuration_context, digest: response.configuration_context_digest, previous: history.length }
      const pending = queue.pendingEntries().find(row => row.kind === 'service_coverage' && row.payload.doctor_user_id === doctorId && row.payload.institution_id === institution)
      const latest = pending ? pending.payload : history[history.length - 1]
      this.setData({ busy: false, history, periodsText: latest ? periodText(latest.working_periods) : '', responseMinutes: latest ? String(latest.expected_response_working_minutes) : '',
        processReference: latest ? latest.approved_process_reference : '', instructions: latest ? latest.escalation_instructions : '',
        pendingId: pending ? pending.id : '', pendingStatus: pending ? pending.status : '', canArchivePending: queue.canArchive(pending), statusText: pending ? '本机保留原配置，先按原编号核对服务器确认。' : '' })
      return true
    } catch (failure) {
      if (this._current(version)) this.setData({ busy: false, history: [], errorText: '配置历史读取失败或不一致，请重试。' })
      return false
    }
  },
  onFieldInput(event) {
    const field = event.currentTarget.dataset.field
    if (this._usable() && this.data.canConfigure && !this.data.busy && !this.data.pendingId && ['periodsText', 'responseMinutes', 'processReference', 'instructions'].includes(field)) this.setData({ [field]: event.detail.value })
  },
  async saveVersion() {
    if (!this._usable() || !this.data.canConfigure || !this._original || !this.data.doctorId || this.data.busy || this.data.pendingId) return false
    let payload
    try {
      const minutes = Number(this.data.responseMinutes), periods = parsePeriods(this.data.periodsText)
      if (!positive(minutes) || minutes > 10080 || !this.data.processReference.trim() || !this.data.instructions.trim()) throw new Error('请填写实际工作时段、工作分钟窗口、批准流程引用和现实处理说明。')
      const id = `coverage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
      payload = { client_coverage_id: id, doctor_user_id: this.data.doctorId, institution_id: this.data.institution,
        expected_previous_version: this._original.previous, timezone: 'Asia/Shanghai', working_periods: periods,
        expected_response_working_minutes: minutes, approved_process_reference: this.data.processReference,
        escalation_instructions: this.data.instructions, configuration_context: this._original.context }
    } catch (failure) { this.setData({ errorText: failure.message }); return false }
    const version = this._version = (this._version || 0) + 1
    this.setData({ busy: true, errorText: '', statusText: '' })
    try {
      const confirmed = await new Promise(resolve => wx.showModal({ title: '确认本机构覆盖版本',
        content: `医生账号 ${payload.doctor_user_id}，替代原版本 ${payload.expected_previous_version}。\n${this.data.periodsText}\n期望窗口 ${payload.expected_response_working_minutes} 个工作分钟。\n${payload.escalation_instructions}\n仅记录实际配置，不代表真实部署准入已核验。`,
        confirmText: '确认保存', success: result => resolve(result.confirm === true), fail: () => resolve(false) }))
      if (!this._current(version)) return false
      if (!confirmed) { this.setData({ busy: false }); return false }
      queue.enqueue({ id: payload.client_coverage_id, kind: 'service_coverage', route: '/identity/service-coverage-versions',
        expected_context_digest: this._original.digest, payload })
      this.setData({ pendingId: payload.client_coverage_id, pendingStatus: 'pending_sync' })
      const ack = await queue.syncQueued(payload.client_coverage_id)
      if (!this._current(version)) return false
      this.setData({ busy: false })
      if (ack) {
        const readVersion = this._version + 1, refreshed = await this._readVersions()
        if (this._current(readVersion)) this.setData({ statusText: refreshed ? '服务器已确认配置版本，历史已重新读取。' : '服务器已确认配置，历史暂未读取，请刷新核对。' })
        return true
      }
      const pending = queue.pendingEntries().find(row => row.id === payload.client_coverage_id)
      this.setData({ pendingStatus: pending ? pending.status : '', statusText: '原配置已保存在本机，尚未获得服务器确认；请按原编号查询。' }); return false
    } catch (failure) {
      if (this._current(version)) this.setData({ busy: false, errorText: /^QUEUE_/.test(failure.code || '') ? failure.message : '保存未确认，请保留原件并核对。' })
      return false
    }
  },
  async queryPending() {
    if (!this._usable() || this.data.busy || !this.data.pendingId) return false
    const id = this.data.pendingId, version = this._version = (this._version || 0) + 1
    this.setData({ busy: true, errorText: '' })
    const found = await queue.queryQueuedStatus(id)
    if (!this._current(version)) return false
    this.setData({ busy: false })
    if (found) {
      const readVersion = this._version + 1, refreshed = await this._readVersions()
      if (this._current(readVersion)) this.setData({ statusText: refreshed ? '服务器已确认原配置编号，历史已重新读取。' : '服务器已确认原配置编号；历史读取失败，请刷新。' })
    } else {
      const pending = queue.pendingEntries().find(row => row.id === id)
      this.setData({ pendingStatus: pending ? pending.status : '', canArchivePending: queue.canArchive(pending), statusText: '尚无一致的服务器确认，原件仍在本机；可到待确认记录查看。' })
    }
    return Boolean(found)
  },
  async archivePending() {
    if (!this._usable() || this.data.busy || this.data.loading || !this.data.pendingId) return false
    const id = this.data.pendingId, version = this._version = (this._version || 0) + 1
    this.setData({ busy: true, errorText: '' })
    try {
      if (!queue.canArchive(queue.pendingEntries().find(row => row.id === id))) throw new Error('请先查询原编号；只有明确拒绝且最近查询未找到的原件可以归档。')
      const confirmed = await new Promise(resolve => wx.showModal({ title: '保留原配置并重新核对',
        content: `原编号：${id}\n服务器曾拒绝本次提交，最近原编号查询未找到。原件会保留在本机并停止重发；这不表示已撤销服务器请求。请重新选择医生、读取当前版本并确认新配置。`,
        success: result => resolve(result.confirm === true), fail: () => resolve(false) }))
      if (!this._current(version)) return false
      if (!confirmed) { this.setData({ busy: false }); return false }
      if (!queue.archiveQueued(id, { confirmed: true })) throw new Error('原件归档未保存或状态已变化，请重新查询核对。')
      this._original = null; this.setData({ ...blank(), busy: false })
      const readVersion = this._version + 1, refreshed = await this.reload()
      if (this._current(readVersion)) this.setData({ statusText: refreshed ? '原配置已在本机归档保留，仍可查询原编号。请重新选择医生并确认当前版本。' : '原配置已在本机归档保留；实际范围读取失败，请刷新后重新选择医生。' })
      return true
    } catch (failure) {
      if (this._current(version)) this.setData({ busy: false, errorText: failure.message || '原配置归档失败，请保留原件。' })
      return false
    }
  },
  openPending() { if (this._usable()) wx.navigateTo({ url: '/pages/submission-queue/index' }) }
}, options => hasValidAnySession() || ensurePatientSession(options)))
