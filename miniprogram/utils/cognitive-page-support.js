const { request, isPatientSessionError } = require('./request')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('./session-privacy')
const { resolveAgeGroup } = require('./cognitive-config')
const { LATEST_RESULTS_KEY, mergeLatestResult } = require('./cognitive-results')
const { BATTERY_STATE_KEY, createBatteryState, normalizeBatteryState, completeBatteryTask, nextBatteryTask } = require('./cognitive-battery')

const TASK_URLS = Object.freeze({
  reaction: '/pages/cognitive/index?mode=battery',
  simple_reaction: '/pages/simple-reaction/index?mode=battery',
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

async function syncPayload(page, payload, pendingKey) {
  if (!payload || page.data.submitting) return false
  page.setData({ submitting: true, syncStatus: '同步中' })
  const lease = capturePatientSessionLease()
  try {
    await request({ url: '/patient/submit_cognitive_test', method: 'POST', data: payload })
    if (!isPatientSessionLeaseCurrent(lease)) return false
    wx.removeStorageSync(pendingKey)
    page.setData({ submitting: false, syncStatus: '已同步', hasPendingResult: false })
    return true
  } catch (error) {
    if (isPatientSessionError(error) || !isPatientSessionLeaseCurrent(lease)) return false
    wx.setStorageSync(pendingKey, payload)
    page.setData({ submitting: false, syncStatus: '待同步', hasPendingResult: true })
    return false
  }
}

function finishPage(page, taskId, payload, pendingKey) {
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
  const timer = setTimeout(() => {
    page._timers = (page._timers || []).filter((value) => value !== timer)
    callback()
  }, delay)
  page._timers = [...(page._timers || []), timer]
  return timer
}

module.exports = { loadCognitiveContext, recordBatteryCompletion, finishPage, retryPageSync, goNextBatteryTask, clearTimers, schedule }
