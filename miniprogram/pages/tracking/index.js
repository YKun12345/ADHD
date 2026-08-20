const { request } = require('../../utils/request')
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
    note: log.note || ''
  }
}

Page({
  data: {
    patientName: '患者',
    moods: MOODS,
    ratings: RATINGS,
    sleepOptions: SLEEP_OPTIONS,
    ...createTrackingForm(),
    completedDays: [],
    completedCount: 0,
    totalDays: 14,
    progressPercent: 0,
    submitting: false,
    saveStatus: '',
    demoMode: false
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
    if (!['moodTag', 'attentionRating'].includes(field)) return
    this.setData({ [field]: Number(value), saveStatus: '' })
  },

  selectSleep(event) {
    this.setData({ sleepQuality: event.currentTarget.dataset.value, saveStatus: '' })
  },

  onFieldInput(event) {
    const field = event.currentTarget.dataset.field
    if (!['focusMinutes', 'medicationDosage', 'note'].includes(field)) return
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
      currentDay: completedDays.length ? Math.min(14, completedDays.at(-1) + 1) : 1,
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

    try {
      await request({ url: '/patient/submit_daily_log', method: 'POST', data: payload })
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
      this.setData({ submitting: false, saveStatus: '已保存本机，待同步' })
    }
  },

  generateDemoData() {
    wx.showModal({
      title: '生成本地演示数据',
      content: '将覆盖本机的追踪记录，不会提交到服务器。',
      confirmText: '生成演示',
      success: (result) => {
        if (!result.confirm) return
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

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})

module.exports = { MOODS, RATINGS, SLEEP_OPTIONS, formFromLog }
