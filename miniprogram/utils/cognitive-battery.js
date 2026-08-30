const { TASK_ORDER } = require('./cognitive-config')

const BATTERY_STATE_KEY = 'cognitive_battery_state'

function createBatteryState(patientKey, ageGroup, startedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    patientKey: String(patientKey || ''),
    ageGroup: ageGroup === 'adult' ? 'adult' : 'child',
    mode: 'battery',
    completedTaskIds: [],
    startedAt,
    updatedAt: startedAt,
    completed: false
  }
}

function normalizeBatteryState(value, patientKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.schemaVersion !== 1 || value.mode !== 'battery') return null
  if (String(value.patientKey || '') !== String(patientKey || '')) return null
  if (!Array.isArray(value.completedTaskIds)) return null
  const completedTaskIds = TASK_ORDER.filter((id) => value.completedTaskIds.includes(id))
  return {
    ...value,
    ageGroup: value.ageGroup === 'adult' ? 'adult' : 'child',
    completedTaskIds,
    completed: completedTaskIds.length === TASK_ORDER.length
  }
}

function completeBatteryTask(state, taskId, updatedAt = new Date().toISOString()) {
  const current = normalizeBatteryState(state, state && state.patientKey)
  if (!current || !TASK_ORDER.includes(taskId)) return current
  const completedTaskIds = current.completedTaskIds.includes(taskId)
    ? current.completedTaskIds.slice()
    : [...current.completedTaskIds, taskId]
  completedTaskIds.sort((a, b) => TASK_ORDER.indexOf(a) - TASK_ORDER.indexOf(b))
  return {
    ...current,
    completedTaskIds,
    updatedAt,
    completed: completedTaskIds.length === TASK_ORDER.length
  }
}

function nextBatteryTask(state) {
  const current = normalizeBatteryState(state, state && state.patientKey)
  if (!current) return TASK_ORDER[0]
  return TASK_ORDER.find((id) => !current.completedTaskIds.includes(id)) || ''
}

module.exports = {
  BATTERY_STATE_KEY,
  createBatteryState,
  normalizeBatteryState,
  completeBatteryTask,
  nextBatteryTask
}
