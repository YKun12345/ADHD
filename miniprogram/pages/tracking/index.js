const { registerPatientPage } = require('../../utils/patient-page')
const { request } = require('../../utils/request')
const {
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
} = require('../../utils/session-privacy')
const {
  TRACKING_LOGS_KEY,
  TRACKING_PENDING_KEY,
  createTrackingForm,
  validateTrackingForm,
  buildTrackingPayload,
  upsertTrackingLog,
  summarizeTrackingLogs,
  buildDemoTrackingLogs
} = require('../../utils/tracking-data')

const MOODS = [
  { value: 1, label: '很低落' },
  { value: 2, label: '有些低落' },
  { value: 3, label: '平稳' },
  { value: 4, label: '不错' },
  { value: 5, label: '很好' }
]
const RATINGS = [1, 2, 3, 4, 5]
const SLEEP_OPTIONS = [
  { value: 'poor', label: '较差' },
  { value: 'fair', label: '一般' },
  { value: 'good', label: '良好' }
]
const APPETITE_OPTIONS = [
  { value: 'poor', label: '较差' }, { value: 'normal', label: '正常' }, { value: 'good', label: '良好' }
]
const ACTIVITY_OPTIONS = ['学习', '工作', '运动', '社交', '户外', '放松']

function formFromLog(log, fallbackDay) {
  if (!log) return createTrackingForm(fallbackDay)
  return {
    dayIndex: log.day_index,
    moodTag: Number(log.mood_tag) || 0,
    attentionRating: Number(log.attention_rating) || 0,
    focusMinutes: log.focus_minutes == null ? '' : String(log.focus_minutes),
    sleepQuality: log.sleep_quality || '',
    isMedication: log.is_medication === true,
    medicationDosage: log.medication_dosage || '',
    note: log.note || '',
    detailedExpanded: false,
    hyperactivityRating: Number(log.hyperactivity_rating) || 0,
    impulsivityRating: Number(log.impulsivity_rating) || 0,
    emotionStabilityRating: Number(log.emotion_rating) || 0,
    taskCompletionRating: Number(log.task_completion_rating) || 0,
    appetiteQuality: log.appetite_quality || '',
    sideEffects: log.side_effects || '',
    activityTags: Array.isArray(log.activities)
      ? log.activities.map(String).map((item) => item.trim()).filter(Boolean)
      : typeof log.activities === 'string' ? log.activities.split(',').filter(Boolean) : [],
    hasConflict: log.has_conflict === true,
    wasCriticized: log.was_criticized === true,
    specialEvents: log.special_events || '',
    highlights: log.highlights || '',
    noteFocused: false
  }
}

registerPatientPage({
  data: {
    patientName: '患者',
    moods: MOODS,
    ratings: RATINGS,
    sleepOptions: SLEEP_OPTIONS,
    appetiteOptions: APPETITE_OPTIONS,
    activityOptions: ACTIVITY_OPTIONS,
    days: Array.from({ length: 14 }, (_, index) => index + 1),
    ...createTrackingForm(),
    completedDays: [],
    completedCount: 0,
    totalDays: 14,
    progressPercent: 0,
    submitting: false,
    saveStatus: '',
    demoMode: false,
    noteFocused: false
  },

  onLoad() {
    const user = wx.getStorageSync('current_user') || {}
    const dashboard = wx.getStorageSync('patient_dashboard_cache') || {}
    const logs = wx.getStorageSync(TRACKING_LOGS_KEY) || []
    const summary = summarizeTrackingLogs(logs)
    const day = Number.isInteger(dashboard.currentDay)
      ? dashboard.currentDay
      : summary.currentDay
    const existing = logs.find((log) => log.day_index === Math.min(14, Math.max(1, day)))

    this.setData({
      patientName: user.full_name || '患者',
      ...summary,
      ...formFromLog(existing, day),
      demoMode: logs.some((log) => log.demo === true)
    })
  },

  selectDay(event) {
    const day = Number(event.currentTarget.dataset.day)
    const logs = wx.getStorageSync(TRACKING_LOGS_KEY) || []
    this.setData({
      ...formFromLog(logs.find((log) => log.day_index === day), day),
      saveStatus: ''
    })
  },

  selectRating(event) {
    const { field, value } = event.currentTarget.dataset
    if (!['moodTag', 'attentionRating', 'hyperactivityRating', 'impulsivityRating', 'emotionStabilityRating', 'taskCompletionRating'].includes(field)) return
    this.setData({ [field]: Number(value), saveStatus: '' })
  },

  selectSleep(event) {
    this.setData({ sleepQuality: event.currentTarget.dataset.value, saveStatus: '' })
  },

  selectAppetite(event) { this.setData({ appetiteQuality: event.currentTarget.dataset.value, saveStatus: '' }) },
  toggleDetailed() { this.setData({ detailedExpanded: !this.data.detailedExpanded }) },
  toggleActivity(event) {
    const value = event.currentTarget.dataset.value
    if (!this.data.activityOptions.includes(value)) return
    const selected = this.data.activityTags.includes(value)
      ? this.data.activityTags.filter((item) => item !== value)
      : this.data.activityTags.concat(value)
    this.setData({ activityTags: selected, saveStatus: '' })
  },
  toggleDetailFlag(event) {
    const field = event.currentTarget.dataset.field
    if (['hasConflict', 'wasCriticized'].includes(field)) this.setData({ [field]: !this.data[field], saveStatus: '' })
  },
  onNoteFocus() { this.setData({ noteFocused: true }) },
  onNoteBlur() { this.setData({ noteFocused: false }) },

  onFieldInput(event) {
    const field = event.currentTarget.dataset.field
    if (!['focusMinutes', 'medicationDosage', 'note', 'sideEffects', 'specialEvents', 'highlights'].includes(field)) return
    this.setData({ [field]: event.detail.value, saveStatus: '' })
  },

  toggleMedication() {
    this.setData({ isMedication: !this.data.isMedication, saveStatus: '' })
  },

  _updateDashboard(summary) {
    const cache = wx.getStorageSync('patient_dashboard_cache') || {}
    const completedDays = Array.from(new Set([
      ...(Array.isArray(cache.completedDays) ? cache.completedDays : []),
      ...summary.completedDays
    ])).filter((day) => Number.isInteger(day) && day >= 1 && day <= 14).sort((a, b) => a - b)
    wx.setStorageSync('patient_dashboard_cache', {
      currentDay: completedDays.length
        ? Math.min(14, completedDays[completedDays.length - 1] + 1)
        : 1,
      completedDays
    })
  },

  async submitTracking() {
    if (this.data.submitting) return
    const errorMessage = validateTrackingForm(this.data)
    if (errorMessage) {
      wx.showToast({ title: errorMessage, icon: 'none' })
      return
    }
    const payload = buildTrackingPayload(this.data)
    const savedAt = new Date().toISOString()
    let logs = upsertTrackingLog(wx.getStorageSync(TRACKING_LOGS_KEY), {
      ...payload,
      demo: false,
      sync_status: 'pending',
      saved_at: savedAt
    })
    const pending = { ...(wx.getStorageSync(TRACKING_PENDING_KEY) || {}), [payload.day_index]: payload }
    wx.setStorageSync(TRACKING_LOGS_KEY, logs)
    wx.setStorageSync(TRACKING_PENDING_KEY, pending)
    const summary = summarizeTrackingLogs(logs)
    this._updateDashboard(summary)
    this.setData({ ...summary, submitting: true, saveStatus: '正在同步', demoMode: false })

    const lease = capturePatientSessionLease()

    try {
      await request({ url: '/patient/submit_daily_log', method: 'POST', data: payload })
      if (!isPatientSessionLeaseCurrent(lease)) return
      logs = upsertTrackingLog(logs, {
        ...logs.find((log) => log.day_index === payload.day_index),
        sync_status: 'synced'
      })
      const nextPending = { ...pending }
      delete nextPending[payload.day_index]
      wx.setStorageSync(TRACKING_LOGS_KEY, logs)
      wx.setStorageSync(TRACKING_PENDING_KEY, nextPending)
      this.setData({ submitting: false, saveStatus: '已同步' })
    } catch (error) {
      if (!isPatientSessionLeaseCurrent(lease)) return
      this.setData({ submitting: false, saveStatus: '已保存本机，待同步' })
    }
  },

  generateDemoData() {
    const lease = capturePatientSessionLease()
    wx.showModal({
      title: '生成本地演示数据',
      content: '将覆盖本机的追踪记录，不会提交到服务器。',
      confirmText: '生成演示',
      success: (result) => {
        if (!result.confirm || !isPatientSessionLeaseCurrent(lease)) return
        const logs = buildDemoTrackingLogs()
        const summary = summarizeTrackingLogs(logs)
        wx.setStorageSync(TRACKING_LOGS_KEY, logs)
        wx.setStorageSync(TRACKING_PENDING_KEY, {})
        this._updateDashboard(summary)
        this.setData({
          ...summary,
          ...formFromLog(logs[0], 1),
          saveStatus: '本地演示数据已生成',
          demoMode: true
        })
      }
    })
  },

  openTrend() {
    wx.navigateTo({ url: '/pages/tracking-trend/index' })
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})

module.exports = { MOODS, RATINGS, SLEEP_OPTIONS, APPETITE_OPTIONS, ACTIVITY_OPTIONS, formFromLog }
