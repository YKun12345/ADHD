const { request } = require('./request')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('./session-privacy')
const { resolveApiBaseUrl } = require('./api-config')
const { supportsItem } = require('./care-capabilities')

const EXECUTION_KEY = 'assessment_execution_v1'
const SCALE_DRAFTS_KEY = 'assessment_scale_drafts_v1'
const ROUTES = Object.freeze({ scale: 'scale', reaction: 'cognitive', stroop: 'stroop', flanker: 'flanker', nback: 'nback', trail: 'trail', digit: 'digit-span' })
const positive = value => Number.isInteger(Number(value)) && Number(value) > 0
const copy = value => JSON.parse(JSON.stringify(value))
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function owner() {
  const user = wx.getStorageSync('current_user') || {}
  if (user.role !== 'patient' || !positive(user.id)) throw new Error('请先登录获准的用户账号。')
  return { user_id: user.id, role: user.role, api_origin: resolveApiBaseUrl(wx.getStorageSync('api_base_url')) }
}
function observeDevice() {
  let info = {}
  try { if (typeof wx.getSystemInfoSync === 'function') info = wx.getSystemInfoSync() } catch (_) {}
  const deviceType = info.platform === 'devtools' ? 'simulator' : ['ios', 'android'].includes(info.platform) ? 'phone' : 'unknown'
  return { device: { platform: 'miniprogram', environment: info.platform || 'unknown', device_type: deviceType,
    device_model: info.model || null, viewport_width: info.windowWidth || null, viewport_height: info.windowHeight || null },
  input: { method: deviceType === 'phone' ? 'touch' : 'unknown' }, timing: { clock_source: 'Date.now', unit: 'ms', calibrated: false } }
}
function assertDeviceUnchanged(context) {
  assertCurrent(context)
  const actual = observeDevice(), start = context.attempt.metadata
  for (const section of ['device', 'input', 'timing']) for (const key of Object.keys(actual[section])) {
    if ((actual[section][key] == null ? null : actual[section][key]) !== (start[section][key] == null ? null : start[section][key])) throw new Error('设备、输入或显示条件已变化，请返回本轮评估创建新尝试。')
  }
}
function assertCurrent(context) {
  if (!context || !isPatientSessionLeaseCurrent(context.lease) || canonical(owner()) !== canonical(context.owner)) throw new Error('账号或服务器已变更，请重新进入评估。')
}
async function loadExecution(query = {}, task) {
  if (!['assessment_id', 'item_id', 'attempt_id'].some(key => query[key] !== undefined)) return null
  if (!['assessment_id', 'item_id', 'attempt_id'].every(key => positive(query[key]))) throw new Error('评估归属不完整，请从本轮评估重新进入。')
  const context = { owner: owner(), lease: capturePatientSessionLease() }
  const session = await request({ url: `/care/assessments/${Number(query.assessment_id)}` })
  assertCurrent(context)
  const item = session && (session.items || []).find(value => value.id === Number(query.item_id))
  const attempt = item && (item.attempts || []).find(value => value.id === Number(query.attempt_id))
  const repeat = item && item.repeat_request, originalRepeat = attempt && attempt.metadata && attempt.metadata.repeat_request
  const continuing = repeat && originalRepeat && repeat.continuing_attempt_id === attempt.id &&
    repeat.report_id === originalRepeat.report_id && repeat.source_attempt_id === originalRepeat.source_attempt_id && originalRepeat.assessment_item_id === item.id
  if (!session || session.id !== Number(query.assessment_id) || !(['active', 'under_review'].includes(session.status)) || !item || !attempt ||
    session.patient_id !== item.patient_id || session.patient_id !== attempt.patient_id || attempt.assessment_id !== session.id ||
    attempt.assessment_item_id !== item.id || attempt.actor_user_id !== context.owner.user_id || attempt.submitter_user_id !== context.owner.user_id ||
    attempt.execution_status !== 'in_progress' || !(continuing || session.status === 'active' && (item.allowed_actions || []).includes('create_attempt')) ||
    (task === 'scale' ? item.kind !== 'scale' : item.kind !== 'cognitive' || item.instrument !== task) ||
    item.config_digest !== attempt.config_digest || session.template_digest !== attempt.template_digest ||
    item.protocol_id !== attempt.protocol_id || item.protocol_schema_version !== attempt.protocol_schema_version ||
    canonical(item.config) !== canonical(attempt.config_snapshot)) throw new Error('服务器尝试、身份或配置不一致，请创建新尝试。')
  if (!supportsItem(item, attempt.age_group)) throw new Error('当前客户端不支持这一协议或冻结配置，请更新后创建新尝试。')
  return { ...context, session: copy(session), item: copy(item), attempt: copy(attempt) }
}
function executionUrl(session, item, attempt) {
  const route = ROUTES[item.kind === 'scale' ? 'scale' : item.instrument]
  if (!route || attempt.assessment_id !== session.id || attempt.assessment_item_id !== item.id || attempt.patient_id !== session.patient_id) throw new Error('尝试响应与本轮不一致。')
  return `/pages/${route}/index?assessment_id=${session.id}&item_id=${item.id}&attempt_id=${attempt.id}`
}
function beginExecution(context) {
  assertCurrent(context)
  assertDeviceUnchanged(context)
  const stored = wx.getStorageSync(EXECUTION_KEY)
  if (stored && (stored.version !== 1 || canonical(stored.owner) !== canonical(context.owner) || !Array.isArray(stored.started_runs))) throw new Error('本机执行记录无法核验，请检查账号与隐私。')
  const next = stored ? copy(stored) : { version: 1, owner: context.owner, started_runs: [] }
  if (next.started_runs.includes(context.attempt.run_id)) throw new Error('该认知运行已开始或中断，请返回本轮评估创建新尝试。')
  next.started_runs.push(context.attempt.run_id)
  wx.setStorageSync(EXECUTION_KEY, next)
  if (canonical(wx.getStorageSync(EXECUTION_KEY)) !== canonical(next)) throw new Error('执行记录保存失败，尚未开始，请重试。')
}
function buildSubmission(context, content) {
  assertCurrent(context)
  const { attempt, item, session } = context
  const payload = { submission_id: `wx-${attempt.run_id}`, kind: item.kind, patient_id: session.patient_id,
    assessment_id: session.id, assessment_item_id: item.id, attempt_id: attempt.id, run_id: attempt.run_id,
    task_id: item.patient_task_id == null ? null : item.patient_task_id, content: copy(content) }
  for (const key of ['protocol_id', 'protocol_schema_version', 'config_digest', 'template_digest', 'actor_user_id',
    'performer_kind', 'performer_user_id', 'performer_patient_id', 'respondent_user_id', 'respondent_kind', 'submitter_user_id']) payload[key] = attempt[key]
  return payload
}
function scaleDraftStore(context) {
  assertCurrent(context)
  const stored = wx.getStorageSync(SCALE_DRAFTS_KEY)
  if (!stored) return { version: 1, owner: context.owner, drafts: {} }
  if (stored.version !== 1 || canonical(stored.owner) !== canonical(context.owner) || !stored.drafts || typeof stored.drafts !== 'object') throw new Error('量表草稿归属无法核验，请检查账号与隐私。')
  return copy(stored)
}
function readScaleDraft(context) {
  const draft = scaleDraftStore(context).drafts[context.attempt.run_id]
  if (!draft) return []
  if (draft.attempt_id !== context.attempt.id || draft.patient_id !== context.attempt.patient_id || draft.content_digest !== context.item.content_digest || !Array.isArray(draft.answers)) throw new Error('草稿与本次量表不一致，不能自动认领。')
  return copy(draft.answers)
}
function saveScaleDraft(context, answers) {
  const stored = scaleDraftStore(context)
  stored.drafts[context.attempt.run_id] = { attempt_id: context.attempt.id, patient_id: context.attempt.patient_id,
    content_digest: context.item.content_digest, answers: copy(answers) }
  wx.setStorageSync(SCALE_DRAFTS_KEY, stored)
  if (canonical(wx.getStorageSync(SCALE_DRAFTS_KEY)) !== canonical(stored)) throw new Error('量表草稿未保存，请保留页面并重试。')
}
function clearScaleDraft(context) {
  const stored = scaleDraftStore(context)
  delete stored.drafts[context.attempt.run_id]
  wx.setStorageSync(SCALE_DRAFTS_KEY, stored)
}
module.exports = { EXECUTION_KEY, SCALE_DRAFTS_KEY, loadExecution, executionUrl, beginExecution, buildSubmission, assertCurrent, observeDevice, assertDeviceUnchanged,
  readScaleDraft, saveScaleDraft, clearScaleDraft }
