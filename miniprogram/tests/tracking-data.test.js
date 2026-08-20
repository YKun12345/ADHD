const assert = require('node:assert/strict')

const {
  TRACKING_LOGS_KEY,
  TRACKING_PENDING_KEY,
  createTrackingForm,
  validateTrackingForm,
  buildTrackingPayload,
  upsertTrackingLog,
  summarizeTrackingLogs,
  buildDemoTrackingLogs
} = require('../utils/tracking-data')

assert.equal(TRACKING_LOGS_KEY, 'tracking_local_logs')
assert.equal(TRACKING_PENDING_KEY, 'tracking_pending_logs')
assert.deepEqual(createTrackingForm(20), {
  dayIndex: 14,
  moodTag: 0,
  attentionRating: 0,
  focusMinutes: '',
  sleepQuality: '',
  isMedication: false,
  medicationDosage: '',
  note: ''
})

const validForm = {
  dayIndex: 3,
  moodTag: 4,
  attentionRating: 3,
  focusMinutes: '75',
  sleepQuality: 'good',
  isMedication: true,
  medicationDosage: '遵医嘱 1 次',
  note: ' 下午完成作业 '
}

assert.equal(validateTrackingForm(validForm), '')
assert.equal(validateTrackingForm({ ...validForm, moodTag: 0 }), '请选择今日情绪')
assert.equal(validateTrackingForm({ ...validForm, focusMinutes: '2.5' }), '专注时长应为0至1440之间的整数')
assert.equal(validateTrackingForm({ ...validForm, sleepQuality: 'x' }), '请选择睡眠质量')
assert.equal(validateTrackingForm({ ...validForm, medicationDosage: ' ' }), '请填写用药记录')

const payload = buildTrackingPayload(validForm)
assert.deepEqual(payload, {
  day_index: 3,
  mood_tag: '4',
  focus_minutes: 75,
  note: '下午完成作业',
  is_medication: true,
  medication_dosage: '遵医嘱 1 次',
  attention_rating: 3,
  emotion_rating: 4,
  sleep_quality: 'good'
})
assert.equal(buildTrackingPayload({ ...validForm, dayIndex: 0 }), null)

const firstLog = { ...payload, sync_status: 'pending', saved_at: 'a' }
const secondLog = { ...payload, day_index: 1, saved_at: 'b' }
const replacement = { ...payload, focus_minutes: 90, saved_at: 'c' }
assert.deepEqual(
  upsertTrackingLog([firstLog, secondLog], replacement),
  [secondLog, replacement]
)

assert.deepEqual(summarizeTrackingLogs([firstLog, secondLog]), {
  currentDay: 4,
  completedDays: [1, 3],
  completedCount: 2,
  totalDays: 14,
  progressPercent: 14
})
assert.equal(summarizeTrackingLogs([]).currentDay, 1)

const demoLogs = buildDemoTrackingLogs('2026-08-21T04:00:00.000Z')
assert.equal(demoLogs.length, 14)
assert.deepEqual(demoLogs.map((log) => log.day_index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
assert.equal(demoLogs.every((log) => log.demo === true), true)
assert.equal(demoLogs.every((log) => log.sync_status === 'local_demo'), true)
assert.equal(demoLogs.every((log) => validateTrackingForm({
  dayIndex: log.day_index,
  moodTag: Number(log.mood_tag),
  attentionRating: log.attention_rating,
  focusMinutes: String(log.focus_minutes),
  sleepQuality: log.sleep_quality,
  isMedication: log.is_medication,
  medicationDosage: log.medication_dosage || '',
  note: log.note || ''
}) === ''), true)

console.log('每日追踪数据测试全部通过')
