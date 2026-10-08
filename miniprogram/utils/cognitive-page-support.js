const { request, isPatientSessionError } = require('./request')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('./session-privacy')
const { resolveAgeGroup } = require('./cognitive-config')
const { LATEST_RESULTS_KEY, mergeLatestResult } = require('./cognitive-results')
const { BATTERY_STATE_KEY, createBatteryState, normalizeBatteryState, completeBatteryTask, nextBatteryTask } = require('./cognitive-battery')

const TASK_URLS = Object.freeze({
  reaction: '/pages/cognitive/index?mode=battery',
  stroop: '/pages/stroop/index?mode=battery',
  trail: '/pages/trail/index?mode=battery',
  flanker: '/pages/flanker/index?mode=battery',
  nback: '/pages/nback/index?mode=battery',
  digit: '/pages/digit-span/index?mode=battery'
})

function loadCognitiveContext(query = {}) {
  const user = wx.getStorageSync('current_user') || {}
  return {
    user,
    patientName: user.full_name || '患者',
    patientKey: String(user.id || user.email || 'patient'),
    ageGroup: resolveAgeGroup(user),
    mode: query.mode === 'battery' ? 'battery' : 'single'
  }
}

function saveLatestPayload(payload) {
  wx.setStorageSync(
    LATEST_RESULTS_KEY,
    mergeLatestResult(wx.getStorageSync(LATEST_RESULTS_KEY), payload)
  )
}

function recordBatteryCompletion(context, taskId) {
  if (!context || context.mode !== 'battery') return ''
  const stored = normalizeBatteryState(wx.getStorageSync(BATTERY_STATE_KEY), context.patientKey)
  const state = stored || createBatteryState(context.patientKey, context.ageGroup)
  const completed = completeBatteryTask(state, taskId)
  wx.setStorageSync(BATTERY_STATE_KEY, completed)
  return nextBatteryTask(completed)
}

function attachProtocolMetadata(payload, config, actualTrials) {
  if (!payload || !payload.result_json || !config) return payload
  const trials = Array.isArray(payload.result_json.trials) ? payload.result_json.trials : []
  const rawTotal = Number(payload.result_json.raw_result && payload.result_json.raw_result.total_trials)
  const explicitTotal = Number(actualTrials)
  const resolvedTotal = Number.isInteger(explicitTotal) && explicitTotal >= 0
    ? explicitTotal
    : Number.isInteger(rawTotal) && rawTotal >= 0
      ? rawTotal
      : trials.length
  payload.result_json.protocol_id = config.protocolId
  payload.result_json.protocol_label = config.protocolLabel
  payload.result_json.protocol_schema_version = config.schemaVersion
  payload.result_json.actual_trials = resolvedTotal
  return payload
}

async function syncPayload(page, payload, pendingKey) {
  if (!payload || page._disposed || page.data.submitting) return false
  // Persist before sending: a closed page must not lose an unacknowledged result.
  wx.setStorageSync(pendingKey, payload)
  page.setData({ submitting: true, syncStatus: '同步中' })
  const lease = capturePatientSessionLease()
  const matchesPending = () => {
    const pending = wx.getStorageSync(pendingKey)
    if (!pending || pending.test_type !== payload.test_type) return false
    const runId = payload.result_json && payload.result_json.test_run_id
    return runId
      ? pending.result_json && pending.result_json.test_run_id === runId
      : JSON.stringify(pending) === JSON.stringify(payload)
  }
  try {
    await request({ url: '/patient/submit_cognitive_test', method: 'POST', data: payload })
    if (!isPatientSessionLeaseCurrent(lease)) return false
    if (matchesPending()) wx.removeStorageSync(pendingKey)
    if (!page._disposed) page.setData({ submitting: false, syncStatus: '已同步', hasPendingResult: Boolean(wx.getStorageSync(pendingKey)) })
    return true
  } catch (error) {
    if (isPatientSessionError(error) || !isPatientSessionLeaseCurrent(lease)) return false
    if (!page._disposed) page.setData({ submitting: false, syncStatus: '待同步', hasPendingResult: Boolean(wx.getStorageSync(pendingKey)) })
    return false
  }
}

function finishPage(page, taskId, payload, pendingKey, actualTrials) {
  if (!payload || page._completionSaved || page._disposed || page._hidden) return false
  if (page._runLease && !isPatientSessionLeaseCurrent(page._runLease)) return false
  page._completionSaved = true
  attachProtocolMetadata(payload, page._config, actualTrials)
  if (page._context && page._context.testRunId) payload.result_json.test_run_id = page._context.testRunId
  saveLatestPayload(payload)
  const nextTaskId = recordBatteryCompletion(page._context, taskId)
  page._lastPayload = payload
  page.setData({ phase: 'result', running: false, result: payload.result_json.raw_result, nextTaskId, syncStatus: '同步中' })
  return syncPayload(page, payload, pendingKey)
}

function retryPageSync(page, pendingKey) {
  const payload = wx.getStorageSync(pendingKey) || page._lastPayload
  return syncPayload(page, payload, pendingKey)
}

function goNextBatteryTask(page) {
  const taskId = page.data.nextTaskId
  if (taskId && TASK_URLS[taskId]) wx.redirectTo({ url: TASK_URLS[taskId] })
  else wx.navigateTo({ url: '/pages/report/index' })
}

function clearTimers(page) {
  const timers = Array.isArray(page._timers) ? page._timers : []
  timers.forEach((timer) => clearTimeout(timer))
  page._timers = []
}

function schedule(page, callback, delay) {
  const generation = page._runGeneration
  const lease = capturePatientSessionLease()
  const timer = setTimeout(() => {
    page._timers = (page._timers || []).filter((value) => value !== timer)
    if (page._disposed || page._hidden || generation !== page._runGeneration || !isPatientSessionLeaseCurrent(lease)) return
    callback()
  }, delay)
  page._timers = [...(page._timers || []), timer]
  return timer
}

module.exports = { loadCognitiveContext, recordBatteryCompletion, attachProtocolMetadata, finishPage, syncPayload, retryPageSync, goNextBatteryTask, clearTimers, schedule }
