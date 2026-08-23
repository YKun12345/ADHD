const TRACKING_LOGS_KEY = 'tracking_local_logs'
const TRACKING_PENDING_KEY = 'tracking_pending_logs'
const TOTAL_DAYS = 14
const SLEEP_VALUES = ['poor', 'fair', 'good']

function clampDay(value) {
  const number = Number(value)
  if (!Number.isInteger(number)) {
    return 1
  }
  return Math.min(TOTAL_DAYS, Math.max(1, number))
}

function createTrackingForm(dayIndex = 1) {
  return {
    dayIndex: clampDay(dayIndex),
    moodTag: 0,
    attentionRating: 0,
    focusMinutes: '',
    sleepQuality: '',
    isMedication: false,
    medicationDosage: '',
    note: ''
  }
}

function isRating(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 5
}

function validateTrackingForm(form = {}) {
  if (!Number.isInteger(Number(form.dayIndex)) || Number(form.dayIndex) < 1 || Number(form.dayIndex) > TOTAL_DAYS) {
    return '追踪天数应为1至14之间的整数'
  }
  if (!isRating(form.moodTag)) {
    return '请选择今日情绪'
  }
  if (!isRating(form.attentionRating)) {
    return '请选择今日注意力'
  }
  const focus = Number(form.focusMinutes)
  if (!Number.isInteger(focus) || focus < 0 || focus > 1440 || String(form.focusMinutes).trim() === '') {
    return '专注时长应为0至1440之间的整数'
  }
  if (!SLEEP_VALUES.includes(form.sleepQuality)) {
    return '请选择睡眠质量'
  }
  if (form.isMedication === true && !String(form.medicationDosage || '').trim()) {
    return '请填写用药记录'
  }
  if (String(form.note || '').trim().length > 500) {
    return '备注不能超过500字'
  }
  return ''
}

function buildTrackingPayload(form) {
  if (validateTrackingForm(form)) {
    return null
  }

  return {
    day_index: Number(form.dayIndex),
    mood_tag: String(Number(form.moodTag)),
    focus_minutes: Number(form.focusMinutes),
    note: String(form.note || '').trim() || null,
    is_medication: form.isMedication === true,
    medication_dosage: form.isMedication === true
      ? String(form.medicationDosage || '').trim()
      : null,
    attention_rating: Number(form.attentionRating),
    emotion_rating: Number(form.moodTag),
    sleep_quality: form.sleepQuality
  }
}

function upsertTrackingLog(logs, log) {
  const safeLogs = Array.isArray(logs) ? logs : []
  if (!log || !Number.isInteger(log.day_index) || log.day_index < 1 || log.day_index > TOTAL_DAYS) {
    return [...safeLogs]
  }

  return [
    ...safeLogs.filter((item) => item && item.day_index !== log.day_index),
    log
  ].sort((left, right) => left.day_index - right.day_index)
}

function summarizeTrackingLogs(logs) {
  const completedDays = Array.from(new Set(
    (Array.isArray(logs) ? logs : [])
      .map((log) => log && log.day_index)
      .filter((day) => Number.isInteger(day) && day >= 1 && day <= TOTAL_DAYS)
  )).sort((left, right) => left - right)
  const completedCount = completedDays.length
  const latestDay = completedDays.length
    ? completedDays[completedDays.length - 1]
    : 0

  return {
    currentDay: latestDay ? Math.min(TOTAL_DAYS, latestDay + 1) : 1,
    completedDays,
    completedCount,
    totalDays: TOTAL_DAYS,
    progressPercent: Math.round((completedCount / TOTAL_DAYS) * 100)
  }
}

function buildDemoTrackingLogs(savedAt = new Date().toISOString()) {
  const sleepPattern = ['fair', 'good', 'good', 'poor']
  return Array.from({ length: TOTAL_DAYS }, (_, index) => {
    const day = index + 1
    const mood = 2 + (day % 4)
    return {
      day_index: day,
      mood_tag: String(Math.min(5, mood)),
      focus_minutes: 35 + day * 4,
      note: `第${day}天本地演示记录`,
      is_medication: false,
      medication_dosage: null,
      attention_rating: 2 + (day % 4),
      emotion_rating: Math.min(5, mood),
      sleep_quality: sleepPattern[index % sleepPattern.length],
      demo: true,
      sync_status: 'local_demo',
      saved_at: String(savedAt)
    }
  })
}

module.exports = {
  TRACKING_LOGS_KEY,
  TRACKING_PENDING_KEY,
  TOTAL_DAYS,
  createTrackingForm,
  validateTrackingForm,
  buildTrackingPayload,
  upsertTrackingLog,
  summarizeTrackingLogs,
  buildDemoTrackingLogs
}
