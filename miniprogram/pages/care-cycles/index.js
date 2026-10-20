const { registerPatientPage } = require('../../utils/patient-page')
const { request } = require('../../utils/request')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const queue = require('../../utils/submission-queue')
const isId = value => Number.isInteger(Number(value)) && Number(value) > 0
const newId = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
const plusDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
const fields = ['focusMinutes', 'note', 'moodTag', 'sleepQuality']
const emptyForm = () => ({ focusMinutes: '', note: '', moodTag: '', sleepQuality: '', originalTime: '' })
function displayRecord(row) {
  const content = row.content || {}
  return { ...row, focusText: content.focus_minutes == null ? '未记录' : `${content.focus_minutes} 分钟`,
    recordedTimeText: row.recorded_at == null ? '原记录时间未知' : `原记录时间：${row.recorded_at}`,
    backfillLabel: row.is_backfill ? '补录' : '当日记录', noteText: content.note || '未填写备注' }
}

registerPatientPage({
  assistantDraftKey: 'care-cycles',
  data: { patientId: 0, cycles: [], cycle: null, records: [], history: [], today: '', startDate: '', endDate: '', recordDate: '',
    ...emptyForm(), coverageText: '', loading: false, busy: false, errorText: '', statusText: '', pendingId: '', pendingCycleId: '', canRecord: false },
  async onLoad(options = {}) {
    this._active = true
    this._companionTransferId = typeof options.companion_transfer === 'string' ? options.companion_transfer : ''
    this._invalid = options.patient_id !== undefined && !isId(options.patient_id)
    this.setData({ patientId: isId(options.patient_id) ? Number(options.patient_id) : 0 })
    const loaded = await this.reload()
    if (loaded && this._active && isId(options.cycle_id)) {
      const opened = await this.openCycle({ currentTarget: { dataset: { id: Number(options.cycle_id) } } })
      if (opened) this._applyCompanionTransfer()
      return opened
    }
    return loaded
  },
  onShow() { if (this._ended) return false; this._active = true; return this.reload() },
  onHide() {
    if (this._companionTransferId) require('../../utils/companion-transfer').discard(this._companionTransferId)
    this._companionTransferId = ''
    this._active = false; this._version = (this._version || 0) + 1
    this._reportedAt = null; this._reportedTimeText = ''
    this.setData({ cycles: [], cycle: null, records: [], history: [], ...emptyForm(), coverageText: '', loading: false, busy: false,
      statusText: '', errorText: '', pendingId: '', pendingCycleId: '', canRecord: false })
  },
  onUnload() { this.onHide() },
  onPatientSessionEnded() { this._ended = true; this.onHide() },
  _applyCompanionTransfer() {
    const id = this._companionTransferId; this._companionTransferId = ''
    if (!id) return false
    const cycle = this.data.cycle, record = this.data.records.find(row => row.record_date === this.data.recordDate)
    const value = require('../../utils/companion-transfer').consume(id, { kind: 'daily', patientId: this.data.patientId,
      cycleId: cycle?.id, recordDate: this.data.recordDate, recordRevision: record?.revision || 0,
      cycleStatus: cycle?.processing_status, planVersionId: cycle?.plan_version_id ?? null })
    if (!value || !this.data.canRecord || this.data.pendingId) {
      this.setData({ statusText: '准备内容已失效或日期记录有变化，请回星仔重新核对。' }); return false
    }
    const applied = this.applyAssistantInput({ note: value.note, statusText: '已带入你确认的原话，尚未保存；请核对日期和内容后保存。' })
    if (applied) require('../../utils/companion-transfer').complete(id)
    return applied
  },
  _current(lease, version) { return this._active && !this._ended && this._version === version && isPatientSessionLeaseCurrent(lease) },
  async reload() {
    if (!this._active || this._ended || this.data.loading || this.data.busy) return false
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1; this._version = version
    this.setData({ loading: true, errorText: '' })
    try {
      if (this._invalid) throw new Error('档案标识无效。')
      const context = await request({ url: '/identity/context' })
      if (!this._current(lease, version)) return false
      const patients = context.accessible_patients || []
      const patient = this.data.patientId ? patients.find(row => row.patient_id === this.data.patientId) : patients[0]
      if (!patient || !isId(patient.patient_id)) throw new Error('当前没有可读取的本人或儿童档案。')
      const result = await request({ url: `/care/cycles?patient_id=${patient.patient_id}` })
      if (!this._current(lease, version)) return false
      if (!Array.isArray(result.items) || !/^\d{4}-\d{2}-\d{2}$/.test(result.as_of_date) ||
        result.items.some(row => row.patient_id !== patient.patient_id || !isId(row.id))) throw new Error('周期来源不一致，请重新读取。')
      const creation = queue.pendingEntries().find(row => row.kind === 'cycle_create' && row.payload.patient_id === patient.patient_id)
      this.setData({ patientId: patient.patient_id, cycles: result.items, today: result.as_of_date, loading: false,
        startDate: creation ? creation.payload.start_date : result.as_of_date,
        endDate: creation ? creation.payload.end_date : plusDays(result.as_of_date, 13), pendingCycleId: creation ? creation.id : '' })
      return true
    } catch (failure) {
      if (this._current(lease, version)) this.setData({ loading: false, cycles: [], errorText: failure.message || '周期读取失败，请重试。' })
      return false
    }
  },
  onCycleDate(event) {
    const field = event.currentTarget.dataset.field
    if (['startDate', 'endDate'].includes(field) && !this.data.busy && !this.data.pendingCycleId) this.setData({ [field]: event.detail.value })
  },
  async createCycle() {
    if (this.data.busy || this.data.loading || !this.data.patientId || !this._active || this._ended) return false
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1; this._version = version
    this.setData({ busy: true, errorText: '', statusText: '' })
    try {
      let id = this.data.pendingCycleId
      if (id && !queue.pendingEntries().some(row => row.id === id)) {
        this.setData({ busy: false, pendingCycleId: '', statusText: '待同步状态已变化，正在核对服务器周期。' })
        await this.reload()
        if (!this._active || this._ended || !isPatientSessionLeaseCurrent(lease)) return false
        const actual = this.data.cycles.find(row => row.client_cycle_id === id)
        if (actual) return this.openCycle({ currentTarget: { dataset: { id: actual.id } } })
        return false
      }
      if (!id) {
        id = newId('cycle')
        queue.enqueue({ id, kind: 'cycle_create', route: '/care/cycles', payload: { client_cycle_id: id, patient_id: this.data.patientId,
          cycle_type: 'self', start_date: this.data.startDate, end_date: this.data.endDate } })
        this.setData({ pendingCycleId: id })
      }
      const ack = await queue.syncQueuedAcknowledgement(id)
      if (!this._current(lease, version)) return false
      this.setData({ busy: false, statusText: ack ? '服务器已确认自助记录周期。' : '创建请求已保存在本机，尚未获得服务器确认。', pendingCycleId: ack ? '' : id })
      if (!ack) return false
      await this.reload(); return this.openCycle({ currentTarget: { dataset: { id: ack.id } } })
    } catch (failure) {
      if (this._current(lease, version)) this.setData({ busy: false, errorText: failure.message || '创建失败，请保留页面后重试。' })
      return false
    }
  },
  _applyCycle(result) {
    if (!result || result.patient_id !== this.data.patientId || !isId(result.id) || !Array.isArray(result.records) || !result.summary) throw new Error('周期记录归属不一致。')
    const records = result.records.map(row => {
      if (row.patient_id !== result.patient_id || row.cycle_id !== result.id || !Number.isInteger(row.revision) || row.revision < 1) throw new Error('每日记录来源不一致。')
      return displayRecord(row)
    })
    const pending = queue.pendingEntries().find(row => row.kind === 'cycle_daily' && row.payload.cycle_id === result.id && row.payload.patient_id === result.patient_id)
    this.setData({ cycle: result, records, history: [], today: result.summary.as_of_date,
      recordDate: pending ? pending.payload.record_date : result.summary.as_of_date > result.end_date ? result.end_date : result.summary.as_of_date < result.start_date ? result.start_date : result.summary.as_of_date,
      coverageText: `已记录 ${result.summary.completed_count} / ${result.summary.due_count} 天`,
      canRecord: (result.allowed_actions || []).includes('create_daily'), pendingId: pending ? pending.id : '' })
    this._fillForm(pending ? { content: pending.payload.content, recorded_at: pending.payload.recorded_at } : records.find(row => row.record_date === this.data.recordDate))
  },
  _fillForm(record) {
    const content = record && record.content || {}
    this._reportedAt = record && record.recorded_at || null
    this._reportedTimeText = this._reportedAt ? new Date(Date.parse(this._reportedAt) + 8 * 3600000).toISOString().slice(11, 16) : ''
    this.setData({ ...emptyForm(), focusMinutes: content.focus_minutes == null ? '' : String(content.focus_minutes), note: content.note || '',
      moodTag: content.mood_tag || '', sleepQuality: content.sleep_quality || '', originalTime: this._reportedTimeText })
  },
  async openCycle(event) {
    const id = Number(event.currentTarget.dataset.id)
    if (this.data.busy || this.data.loading || !this._active || this._ended || !this.data.cycles.some(row => row.id === id)) return false
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1; this._version = version
    this.setData({ loading: true, errorText: '', history: [] })
    try {
      const result = await request({ url: `/care/cycles/${id}` })
      if (!this._current(lease, version)) return false
      if (result.id !== id) throw new Error('周期标识不一致。')
      this._applyCycle(result); this.setData({ loading: false }); return true
    } catch (failure) {
      if (this._current(lease, version)) this.setData({ loading: false, cycle: null, records: [], errorText: failure.message || '周期读取失败。' })
      return false
    }
  },
  selectRecordDate(event) {
    if (!this.data.cycle || this.data.busy || this.data.pendingId) return false
    this.setData({ recordDate: event.detail.value, history: [], statusText: '' })
    this._fillForm(this.data.records.find(row => row.record_date === event.detail.value)); return true
  },
  onDailyInput(event) {
    const field = event.currentTarget.dataset.field
    if (fields.includes(field) && !this.data.busy && !this.data.pendingId) this.setData({ [field]: event.detail.value, statusText: '' })
  },
  onOriginalTime(event) { if (!this.data.busy && !this.data.pendingId) this.setData({ originalTime: event.detail.value }) },
  openStageReview() { if (!this._active || this._ended || !this.data.cycle || this.data.busy) return false
    wx.navigateTo({ url: `/pages/cycle-review/index?patient_id=${this.data.patientId}&cycle_id=${this.data.cycle.id}` }); return true },
  async saveDaily() {
    if (!this._active || this._ended || this.data.busy || this.data.loading || !this.data.cycle || !this.data.canRecord) return false
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1; this._version = version
    this.setData({ busy: true, errorText: '', statusText: '' })
    try {
      let id = this.data.pendingId
      if (id && !queue.pendingEntries().some(row => row.id === id)) {
        this.setData({ busy: false, pendingId: '', statusText: '待同步状态已变化，正在重新读取服务器记录。' })
        await this.openCycle({ currentTarget: { dataset: { id: this.data.cycle.id } } }); return false
      }
      if (!id) {
        const prior = this.data.records.find(row => row.record_date === this.data.recordDate)
        const focus = this.data.focusMinutes.trim(), note = this.data.note.trim(), content = { ...(prior ? prior.content : {}) }
        if (focus !== '') {
          if (!/^\d+$/.test(focus) || Number(focus) > 1440) throw new Error('专注时间请填写0至1440之间的整数，未记录时可留空。')
          content.focus_minutes = Number(focus)
        } else content.focus_minutes = null
        content.note = note || null
        content.mood_tag = this.data.moodTag || null
        content.sleep_quality = this.data.sleepQuality || null
        if (!Object.values(content).some(value => value !== null && value !== '')) throw new Error('请至少填写一项实际记录；未填写不会计作0。')
        id = newId('daily')
        queue.enqueue({ id, kind: 'cycle_daily', route: '/care/daily-records', payload: { client_submission_id: id, patient_id: this.data.patientId,
          cycle_id: this.data.cycle.id, record_date: this.data.recordDate, expected_revision: prior ? prior.revision : 0,
          recorded_at: this.data.originalTime === this._reportedTimeText ? this._reportedAt : this.data.originalTime ? `${this.data.recordDate}T${this.data.originalTime}:00+08:00` : null, content } })
        this.setData({ pendingId: id })
      }
      const ack = await queue.syncQueuedAcknowledgement(id)
      if (!this._current(lease, version)) return false
      this.setData({ busy: false, statusText: ack ? '服务器已确认这次修订，原记录继续保留。' : '这份记录已保存在本机，尚未获得服务器确认。' })
      if (!ack) return false
      this.setData({ pendingId: '' }); return this.openCycle({ currentTarget: { dataset: { id: ack.cycle_id } } })
    } catch (failure) {
      if (this._current(lease, version)) this.setData({ busy: false, errorText: failure.message || '保存失败，请保留页面并重试。' })
      return false
    }
  },
  async showHistory(event) {
    if (!this.data.cycle || this.data.busy || this.data.loading || !this._active || this._ended) return false
    const date = event.currentTarget.dataset.date, id = this.data.cycle.id
    if (!this.data.records.some(row => row.record_date === date)) return false
    const lease = capturePatientSessionLease(), version = (this._version || 0) + 1; this._version = version
    this.setData({ loading: true, errorText: '', history: [] })
    try {
      const value = await request({ url: `/care/cycles/${id}/daily-history?record_date=${encodeURIComponent(date)}` })
      if (!this._current(lease, version)) return false
      if (!Array.isArray(value.items) || value.items.some(row => row.patient_id !== this.data.patientId || row.cycle_id !== id || row.record_date !== date)) throw new Error('修订历史来源不一致。')
      this.setData({ history: value.items.map(displayRecord), loading: false }); return true
    } catch (failure) {
      if (this._current(lease, version)) this.setData({ loading: false, errorText: failure.message || '历史读取失败。' })
      return false
    }
  },
  openQueue() { wx.navigateTo({ url: '/pages/submission-queue/index' }) },
  openLegacy() { wx.navigateTo({ url: '/pages/tracking/index' }) }
})
