const { protectPatientPage } = require('./patient-page')
const { hasValidAnySession } = require('./role-session')
const { ensurePatientSession, capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('./session-privacy')
const { request } = require('./request')
const queue = require('./submission-queue')
const positive = value => Number.isInteger(Number(value)) && Number(value) > 0
const timeLabel = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
  ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + '（北京时间）' : '待核对'
const labels = { pending_acceptance: '等待接收医生接受', accepted: '接收医生已接受', rejected: '接收医生已拒绝', cancelled: '已撤销',
  open: '待查看', acknowledged: '已确认关注', resolved: '已解决', closed_with_reason: '已说明原因关闭', suspended: '已暂停',
  accept: '接受责任交接', reject: '说明原因并拒绝', cancel: '说明原因并撤销', acknowledge: '确认关注', resolve: '标记已解决', close_with_reason: '说明原因关闭' }
const label = value => labels[value] || '状态待核对'
const failureText = failure => failure && failure.statusCode === 403 ? '当前身份或共享授权不可用，请核对后刷新。' :
  failure && failure.statusCode === 409 ? '事项或原授权已变化，请先核对原提交，再重新确认。' : failure && failure.message || '暂时无法读取，请稍后重试。'
function page(definition, clear) {
  return protectPatientPage({
    ...definition,
    onLoad(options = {}) {
      this._active = true; this._lease = capturePatientSessionLease(); this._owner = wx.getStorageSync('current_user') || {}
      this._invalid = options.patient_id !== undefined && !positive(options.patient_id)
      this.setData({ patientId: positive(options.patient_id) ? Number(options.patient_id) : 0, role: this._owner.role,
        fallbackUrl: this._owner.role === 'researcher' ? '/pages/doctor-home/index' : '/pages/home/index' })
      return this.reload()
    },
    onShow() { if (this._ended) return false; this._active = true; return this.reload() },
    onHide() {
      this._active = false; this._version = (this._version || 0) + 1; this._detail = null; this._options = null
      this.setData({ ...clear(), loading: false, busy: false, errorText: '', statusText: '', pendingId: '', pendingStatus: '', canArchivePending: false })
    },
    onUnload() { this._ended = true; this.onHide() },
    onPatientSessionEnded() { this._ended = true; this.onHide() },
    _usable() {
      const user = wx.getStorageSync('current_user') || {}
      if (!this._active || this._ended) return false
      if (!hasValidAnySession() || !isPatientSessionLeaseCurrent(this._lease) || user.id !== this._owner.id || user.role !== this._owner.role) {
        this.onPatientSessionEnded(); return false
      }
      return true
    },
    _begin() {
      if (!this._usable() || this.data.busy || this.data.loading) return null
      const operation = { lease: capturePatientSessionLease(), version: (this._version || 0) + 1 }
      this._version = operation.version; this.setData({ busy: true, errorText: '', statusText: '' }); return operation
    },
    _current(operation) { return !!operation && this._usable() && operation.version === this._version && isPatientSessionLeaseCurrent(operation.lease) },
    async _refreshAfter(operation, refresh = () => this.reload()) {
      if (!this._current(operation)) return false
      this.setData({ busy: false })
      const pending = refresh(), expected = { lease: operation.lease, version: this._version }
      await pending
      return this._current(expected)
    },
    async _patient(operation) {
      if (this._invalid) throw new Error('档案入口无效，请从当前账号重新进入。')
      if (this._owner.role === 'researcher') return 0
      const context = await request({ url: '/identity/context' })
      if (!this._current(operation)) return null
      const available = context.accessible_patients || []
      const chosen = this.data.patientId ? available.find(p => p.patient_id === this.data.patientId) : available[0]
      if (!chosen || !positive(chosen.patient_id)) throw new Error('没有可访问的本人或当前监护档案。')
      return chosen.patient_id
    },
    _pending(kinds) {
      const original = queue.pendingEntries().find(item => kinds.includes(item.kind) && (!this.data.patientId || item.payload.patient_id === this.data.patientId))
      this.setData({ pendingId: original ? original.id : '', pendingStatus: original ? original.status : '', canArchivePending: queue.canArchive(original) }); return original
    },
    async queryPending() {
      const operation = this._begin(); if (!operation || !this.data.pendingId) { if (operation) this.setData({ busy: false }); return false }
      const result = await queue.queryQueuedStatus(this.data.pendingId)
      if (!this._current(operation)) return false
      if (!await this._refreshAfter(operation)) return false
      this.setData({ statusText: result ? '服务器已确认原提交。请查看当前状态。' : '尚未获得确认；原件保留，请核对授权或稍后再查。' })
      return result
    },
    async archivePending() {
      const operation = this._begin(); if (!operation) return false
      const id = this.data.pendingId
      try {
        const original = queue.pendingEntries().find(item => item.id === id)
        if (!queue.canArchive(original)) throw new Error('请先查询原编号。只有提交被拒绝且查询未找到的原件可以本机归档。')
        const agreed = await confirm('保留原件并重新核对', `原编号：${id}\n服务器曾拒绝本次提交，最近原编号查询未找到。原件会保留在本机待确认记录中，停止重发；这不表示已撤销服务器请求。请重新读取事项、选择范围并确认。`)
        if (!this._current(operation)) return false
        if (!agreed) { this.setData({ busy: false }); return false }
        if (!queue.archiveQueued(id, { confirmed: true })) throw new Error('原件状态已变化，请重新核对。')
        if (!await this._refreshAfter(operation)) return false
        this.setData({ statusText: '原件已在本机保留归档，仍可按原编号查询。请重新选择当前事项并确认。' }); return true
      } catch (failure) { if (this._current(operation)) this.setData({ busy: false, errorText: failureText(failure) }); return false }
    },
    openRecovery() { if (!this._usable()) return false; wx.navigateTo({ url: '/pages/submission-queue/index' }); return true }
  }, options => hasValidAnySession() || ensurePatientSession(options))
}
const confirm = (title, content) => new Promise(resolve => wx.showModal({ title, content, success: result => resolve(result.confirm === true), fail: () => resolve(false) }))
const newId = prefix => `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 14)}`
module.exports = { page, positive, label, timeLabel, failureText, confirm, newId }
