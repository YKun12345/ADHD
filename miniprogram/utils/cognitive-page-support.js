const { isPatientSessionError } = require('./request')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('./session-privacy')
const { resolveAgeGroup } = require('./cognitive-config')
const { LATEST_RESULTS_KEY, mergeLatestResult } = require('./cognitive-results')
const { BATTERY_STATE_KEY, createBatteryState, normalizeBatteryState, completeBatteryTask, nextBatteryTask } = require('./cognitive-battery')
const submissionQueue = require('./submission-queue')
const execution = require('./assessment-execution')
const { finishPractice } = require('./cognitive-practice')
const submissionRecovery = require('./submission-recovery')

const PENDING_KEYS = Object.freeze({ reaction: 'pending_cognitive_result', stroop: 'pending_stroop_result', trail: 'pending_trail_result',
  flanker: 'pending_flanker_result', nback: 'pending_nback_result', digit: 'pending_digit_result' })
const canonicalType = value => ({ gonogo: 'reaction', go_no_go: 'reaction', digit_span: 'digit', 'digit-span': 'digit' }[value] || value)
function pendingCognitiveEntries(taskId) {
  return submissionQueue.pendingEntries().filter(item => item.kind === 'legacy_cognitive' && canonicalType(item.payload.test_type) === canonicalType(taskId))
}
function refreshPendingState(page, taskId) {
  try {
    const entries = pendingCognitiveEntries(taskId)
    const unknownLegacy = Boolean(wx.getStorageSync(PENDING_KEYS[taskId]))
    page.setData({ hasPendingResult: entries.length > 0 || unknownLegacy,
      ...(unknownLegacy && !entries.length ? { syncStatus: '旧待同步资料缺少归属，请核对历史后重新测试。' } : {}) })
  } catch (_) { page.setData({ hasPendingResult: false, syncStatus: '待同步资料读取失败，请保留页面并重试。' }) }
}

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
  payload.result_json.source = 'miniprogram'
  payload.result_json.age_group = config.ageGroup === 'adult' ? 'adult' : 'child'
  payload.result_json.protocol_id = config.protocolId
  payload.result_json.protocol_label = config.protocolLabel
  payload.result_json.protocol_schema_version = config.schemaVersion
  payload.result_json.actual_trials = resolvedTotal
  return payload
}

async function syncPayload(page, payload, pendingKey) {
  if (!payload || page._disposed || page.data.submitting) return false
  const lease = capturePatientSessionLease()
  try {
    if (page._execution) return await syncFormalPayload(page, payload, lease)
    const user = wx.getStorageSync('current_user') || {}
    const patientId = payload.patient_id || (page._context && page._context.patientId) || (user.patient_profile && user.patient_profile.id)
    const runId = payload.result_json && payload.result_json.test_run_id
    if (!Number.isInteger(patientId) || patientId <= 0 || typeof runId !== 'string' || !runId) throw new Error('档案或运行归属未确认，请重新进入测试。')
    const id = `legacy:cognitive:${canonicalType(payload.test_type)}:${runId}`
    const saved = submissionQueue.enqueue({ id, kind: 'legacy_cognitive', route: '/patient/submit_cognitive_test', payload: { ...payload, patient_id: patientId } })
    page._lastQueuedId = id
    page._lastPayload = saved.payload
    page.setData({ submitting: true, syncStatus: '同步中', hasPendingResult: true })
    const acknowledged = await submissionQueue.syncQueued(id)
    if (!isPatientSessionLeaseCurrent(lease)) return false
    if (!page._disposed) {
      const pending = pendingCognitiveEntries(payload.test_type), item = pending.find(row => row.id === id)
      const status = acknowledged ? '已同步' : item && item.status === 'authorization_blocked' ? '授权已失效，结果尚未同步，请核对授权。'
        : item && item.status === 'conflict_blocked' ? '提交内容冲突，请核对服务器记录。' : item && item.status === 'ack_unverified' ? '未获得有效提交确认，请重试。' : '待同步'
      page.setData({ submitting: false, syncStatus: status, hasPendingResult: pending.length > 0, canRetrySync: pending.length > 0 })
    }
    return acknowledged
  } catch (error) {
    if (isPatientSessionError(error) || !isPatientSessionLeaseCurrent(lease)) return false
    if (!page._disposed) page.setData({ submitting: false, canRetrySync: true, syncStatus: error.message || '本机保存失败，请保留页面并重试。' })
    return false
  }
}

async function syncFormalPayload(page, payload, lease) {
  if (!page._lastFormalSubmission) execution.assertDeviceUnchanged(page._execution)
  const original = page._lastFormalSubmission || execution.buildSubmission(page._execution, {
    test_type: payload.test_type, result_json: payload.result_json,
    execution_metadata: { ...page._execution.attempt.metadata,
      practice: { completed: page.data.practicePassed, attempts: page._practiceRecords.length, exposure_count: page._practiceRecords.reduce((sum, group) => sum + group.trials.length, 0) },
      practice_records: page._practiceRecords, interrupted_count: Number(page._context.interruptedCount) || 0 }
  })
  // Only the completion metadata belongs to the request, never server-only start fields.
  if (!page._lastFormalSubmission) {
    for (const key of Object.keys(original.content.execution_metadata)) if (!['device', 'input', 'timing', 'practice', 'assistance', 'practice_records', 'interrupted_count'].includes(key)) delete original.content.execution_metadata[key]
  }
  page._lastFormalSubmission = original
  submissionQueue.enqueue({ id: original.submission_id, kind: 'assessment', route: '/care/submissions', payload: original })
  page._lastQueuedId = original.submission_id
  page.setData({ submitting: true, hasPendingResult: true, syncStatus: '同步中' })
  const ack = await submissionQueue.syncQueuedAcknowledgement(original.submission_id)
  if (!isPatientSessionLeaseCurrent(lease)) return false
  if (!page._disposed) {
    const pending = submissionQueue.pendingEntries().find(row => row.id === original.submission_id)
    const quality = { valid: '质量有效', limited: '质量有局限', invalid: '质量无效', pending_validation: '质量待验证' }
    page.setData({ submitting: false, hasPendingResult: Boolean(pending), canRetrySync: Boolean(pending),
      syncStatus: ack ? `已提交 · ${quality[ack.quality_status] || '质量待确认'} · ${ack.acceptance_status === 'pending_review' ? '待医生验收' : '无需医生验收'}`
        : pending && pending.status === 'authorization_blocked' ? '授权已失效，结果尚未同步，请核对授权。'
          : pending && pending.status === 'conflict_blocked' ? '提交内容冲突，请核对服务器记录。' : '待同步' })
  }
  return Boolean(ack)
}

function finishPage(page, taskId, payload, pendingKey, actualTrials) {
  if (!payload || page._completionSaved || page._disposed || page._hidden) return false
  if (page._runLease && !isPatientSessionLeaseCurrent(page._runLease)) return false
  if (page._execution && page.data.practiceStage) return finishPractice(page, taskId, payload)
  page._completionSaved = true
  attachProtocolMetadata(payload, page._config, actualTrials)
  if (page._context && page._context.testRunId) payload.result_json.test_run_id = page._context.testRunId
  page._lastPayload = payload
  page.setData({ phase: 'result', running: false, result: payload.result_json.raw_result, nextTaskId: '', canRetrySync: true, syncStatus: '正在保存' })
  // A recent-result cache cannot be a prerequisite for the durable submission queue.
  try { saveLatestPayload(payload) } catch (_) { /* The original remains available on this page. */ }
  const syncing = syncPayload(page, payload, pendingKey)
  // enqueue is synchronous and completes before transmission; do not advance a battery
  // when the result only exists in memory after a storage failure.
  try {
    const saved = pendingCognitiveEntries(taskId).some(item => item.id === page._lastQueuedId && item.payload.result_json.test_run_id === payload.result_json.test_run_id)
    if (saved) page.setData({ nextTaskId: recordBatteryCompletion(page._context, taskId) })
  } catch (_) { /* Failure of this optional progress cache cannot discard the queue. */ }
  return Promise.resolve(syncing).then(value => { submissionRecovery.resume(); return value },
    failure => { submissionRecovery.resume(); throw failure })
}

function retryPageSync(page, pendingKey) {
  try {
    const taskId = page._taskId || Object.keys(PENDING_KEYS).find(key => PENDING_KEYS[key] === pendingKey)
    const entries = pendingCognitiveEntries(taskId)
    const selected = entries.find(item => item.id === page._lastQueuedId) || entries[0]
    if (selected) return syncPayload(page, selected.payload, pendingKey)
    if (page._lastPayload) return syncPayload(page, page._lastPayload, pendingKey)
    if (wx.getStorageSync(pendingKey)) page.setData({ syncStatus: '旧结果缺少账号或档案归属，不能自动提交；请核对历史后重新测试。' })
  } catch (error) { if (!page._disposed) page.setData({ syncStatus: error.message || '待同步资料读取失败，请重试。' }) }
  return false
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

module.exports = { loadCognitiveContext, recordBatteryCompletion, attachProtocolMetadata, finishPage, syncPayload, retryPageSync, refreshPendingState, goNextBatteryTask, clearTimers, schedule }
