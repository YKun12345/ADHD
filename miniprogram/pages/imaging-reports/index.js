const { request } = require('../../utils/request')
const { protectPatientPage } = require('../../utils/patient-page')
const { hasValidAnySession } = require('../../utils/role-session')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const queue = require('../../utils/submission-queue')
const positive = value => Number.isInteger(Number(value)) && Number(value) > 0
Page(protectPatientPage({
  assistantDraftKey: 'imaging-reports',
  data: { patientId: 0, doctor: false, reports: [], selected: null, body: '', limitations: '', pendingId: '', busy: false, errorText: '', statusText: '' },
  onLoad(options = {}) {
    const actor = wx.getStorageSync('current_user') || {}; this._actor = actor.id; this._role = actor.role; this._lease = capturePatientSessionLease(); this._active = true
    this.setData({ patientId: positive(options.patient_id) ? Number(options.patient_id) : 0, doctor: actor.role === 'researcher' }); return this.reload()
  },
  onShow() { if (this._ended) return; this._active = true; return this.reload() },
  onHide() { this._active = false; this._epoch = (this._epoch || 0) + 1; this._context = null;
    this.setData({ reports: [], selected: null, body: '', limitations: '', pendingId: '', busy: false, errorText: '', statusText: '' }) },
  onUnload() { this._ended = true; this.onHide() },
  usable() { const a = wx.getStorageSync('current_user') || {}; return !this._ended && this._active && hasValidAnySession() && a.id === this._actor && a.role === this._role && isPatientSessionLeaseCurrent(this._lease) },
  current(epoch) { return this.usable() && epoch === this._epoch },
  pending() { const row = queue.pendingEntries().find(row => row.kind === 'imaging_report' && row.payload.patient_id === this.data.patientId); this.setData({ pendingId: row ? row.id : '' }) },
  async reload() {
    if (!this.usable() || this.data.busy) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this._context = null; this.setData({ busy: true, reports: [], selected: null, body: '', limitations: '', errorText: '' })
    try {
      let pid = this.data.patientId
      if (!pid) { const context = await request({ url: '/identity/context' }); if (!this.current(epoch)) return false
        const rows = context.accessible_patients || []; if (rows.length !== 1) throw new Error('请从实际档案进入影像报告。'); pid = rows[0].patient_id; this.setData({ patientId: pid }) }
      this.pending(); const value = await request({ url: `/care/imaging-reports?patient_id=${pid}` }); if (!this.current(epoch)) return false
      if (value.patient_id !== pid || !Array.isArray(value.items) || value.items.some(row => row.patient_id !== pid || row.status !== 'published' || row.submission_status !== 'committed')) throw new Error('影像报告与实际档案不一致。')
      this.setData({ busy: false, reports: value.items.map(row => ({ ...row, originLabel: row.publisher_kind === 'doctor' ? '医生审核版本' : '系统分析，尚未经医生审核', purposeLabel: row.demonstration_only ? '演示报告，不能用于诊断' : '筛查辅助，不能代替诊断' })) }); return true
    } catch (error) { if (this.current(epoch)) this.setData({ busy: false, reports: [], errorText: error.message || '暂未读取影像报告。' }); return false }
  },
  async review(event) {
    if (!this.usable() || !this.data.doctor || this.data.busy || this.data.pendingId) return false
    const row = this.data.reports.find(row => row.id === Number(event.currentTarget.dataset.id)); if (!row) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, selected: null, body: '', limitations: '', errorText: '' })
    try { const ctx = await request({ url: `/care/imaging-reports/publication-context?patient_id=${this.data.patientId}&prediction_id=${row.prediction_id}` }); if (!this.current(epoch)) return false
      if (ctx.actor_user_id !== this._actor || ctx.patient_id !== this.data.patientId || ctx.prediction_id !== row.prediction_id) throw new Error('审核来源与当前医生不同。')
      this._context = ctx; this.setData({ busy: false, selected: row, limitations: row.limitations }); return true
    } catch (error) { if (this.current(epoch)) this.setData({ busy: false, errorText: error.message }); return false }
  },
  onInput(event) { const field = event.currentTarget.dataset.field; if (this.usable() && !this.data.busy && ['body', 'limitations'].includes(field)) this.setData({ [field]: event.detail.value }) },
  async publish() {
    if (!this.usable() || this.data.busy || this.data.pendingId || !this._context || !this.data.body.trim() || !this.data.limitations.trim()) return false
    const ctx = this._context, epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, errorText: '' })
    try { const yes = await new Promise(resolve => wx.showModal({ title: '明确发布医生影像审核版本', content: '确认核对本份实际影像分析的来源、演示标识及局限；原版本保留。', success: value => resolve(value.confirm === true), fail: () => resolve(false) }))
      if (!this.current(epoch)) return false; if (!yes) { this.setData({ busy: false }); return false }
      const id = `image-review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 13)}`
      const payload = { client_publication_id: id, patient_id: ctx.patient_id, prediction_id: ctx.prediction_id, expected_previous_version: ctx.expected_previous_version,
        input_digest: ctx.input_digest, publication_context: ctx.publication_context, body: this.data.body, limitations: this.data.limitations, confirmed: true }
      queue.enqueue({ id, kind: 'imaging_report', route: '/care/imaging-reports', expected_context_digest: ctx.publication_context_digest, payload }); this.pending()
      const ack = await queue.syncQueuedAcknowledgement(id); if (!this.current(epoch)) return false; this.setData({ busy: false }); this.pending()
      if (!ack) { this.setData({ statusText: '发布原件已保存，尚未收到准确确认，请按原编号查询。' }); return false } return this.reload()
    } catch (error) { if (this.current(epoch)) this.setData({ busy: false, errorText: error.message }); return false }
  },
  async queryPending() { if (!this.usable() || this.data.busy || !this.data.pendingId) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true }); const ack = await queue.queryQueuedAcknowledgement(this.data.pendingId)
    if (!this.current(epoch)) return false; this.setData({ busy: false }); this.pending(); if (ack) return this.reload(); return false },
  openRecovery() { if (this.usable()) wx.navigateTo({ url: '/pages/submission-queue/index' }) }
}, () => hasValidAnySession()))
