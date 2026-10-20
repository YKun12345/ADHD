const { protectPatientPage } = require('../../utils/patient-page')
const { hasValidAnySession } = require('../../utils/role-session')
const { ensurePatientSession, capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const { request } = require('../../utils/request')
const positive = value => Number.isInteger(Number(value)) && Number(value) > 0
const categories = { evidence_review: '材料审核', screening_opinion: '医生筛查意见', clinical_assessment: '临床评估意见', self_screening: '自助筛查' }
Page(protectPatientPage({
  data: { patientId: 0, assessmentId: 0, reports: [], report: null, inputText: '', loading: false, errorText: '' },
  onLoad(options = {}) {
    this._active = true; this._lease = capturePatientSessionLease(); const user = wx.getStorageSync('current_user') || {}; this._actor = { id: user.id, role: user.role }
    this._invalid = !positive(options.patient_id) || !positive(options.assessment_id)
    this.setData({ patientId: this._invalid ? 0 : Number(options.patient_id), assessmentId: this._invalid ? 0 : Number(options.assessment_id) }); return this.reload()
  },
  onShow() { if (this._ended) return false; this._active = true; return this.reload() },
  onHide() { this._active = false; this._epoch = (this._epoch || 0) + 1; this.setData({ reports: [], report: null, inputText: '', errorText: '', loading: false }) },
  onUnload() { this._ended = true; this.onHide() },
  onPatientSessionEnded() { this._ended = true; this.onHide() },
  _usable() { const user = wx.getStorageSync('current_user') || {}
    if (!this._active || this._ended) return false
    if (!hasValidAnySession() || !isPatientSessionLeaseCurrent(this._lease) || user.id !== this._actor.id || user.role !== this._actor.role) { this.onPatientSessionEnded(); return false }
    return true
  },
  _current(epoch) { return this._usable() && this._epoch === epoch },
  _check(row) { if (!row || !positive(row.id) || row.patient_id !== this.data.patientId || row.assessment_id !== this.data.assessmentId ||
    row.status !== 'published' || !positive(row.version) || row.submission_status !== 'committed' || row.legacy !== false || !categories[row.category] ||
    typeof row.body !== 'string' || typeof row.limitations !== 'string') throw new Error('已发布报告的归属或版本不完整。')
    return { ...row, categoryLabel: categories[row.category] }
  },
  async reload() {
    if (!this._usable() || this.data.loading) return false
    if (this._invalid) { this.setData({ errorText: '请选择实际档案和评估。' }); return false }
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ loading: true, reports: [], report: null, inputText: '', errorText: '' })
    try { const response = await request({ url: `/care/assessments/${this.data.assessmentId}/reports` }); if (!this._current(epoch)) return false
      if (!response || !Array.isArray(response.items)) throw new Error('报告历史读取不完整。')
      this.setData({ loading: false, reports: response.items.map(row => this._check(row)) }); return true
    } catch (failure) { if (this._current(epoch)) this.setData({ loading: false, errorText: failure.statusCode === 403 ? '当前身份或共享范围无法读取本轮报告。' : failure.message || '报告读取失败。' }); return false }
  },
  async openReport(event) {
    if (!this._usable() || this.data.loading) return false
    const id = Number(event.currentTarget.dataset.id); if (!this.data.reports.some(row => row.id === id)) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ loading: true, report: null, inputText: '', errorText: '' })
    try { const response = await request({ url: `/care/reports/${id}` }); if (!this._current(epoch)) return false
      const report = this._check(response); if (report.id !== id || !report.input_snapshot) throw new Error('报告原版本不完整。')
      this.setData({ loading: false, report, inputText: JSON.stringify(report.input_snapshot, null, 2) }); return true
    } catch (failure) { if (this._current(epoch)) this.setData({ loading: false, errorText: failure.statusCode === 403 ? '当前授权无法读取该报告。' : failure.message || '原报告读取失败。' }); return false }
  }
}, options => hasValidAnySession() || ensurePatientSession(options)))
