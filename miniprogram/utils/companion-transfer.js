// One deliberate hand-off of the user's own words. No shared/private storage.
const pending = new Map()
const returns = new Map()
let serial = 0
const LIMIT = 10 * 60 * 1000
const positive = value => Number.isSafeInteger(value) && value > 0
const canonical = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])))
function identity() {
  const user = wx.getStorageSync('current_user') || {}
  if (!positive(user.id) || !['patient', 'researcher'].includes(user.role)) throw new Error('请先核对当前登录身份。')
  return `${user.role}:${user.id}`
}
function validBinding(value) {
  if (!value || !positive(value.patientId)) return false
  if (value.kind === 'daily') return positive(value.cycleId) && /^\d{4}-\d{2}-\d{2}$/.test(value.recordDate) &&
    Number.isSafeInteger(value.recordRevision) && value.recordRevision >= 0 && value.cycleStatus === 'active' &&
    (value.planVersionId == null || positive(value.planVersionId))
  return value.kind === 'message' && positive(value.relationshipId) && positive(value.revision) && /^[a-f0-9]{64}$/.test(value.contextDigest)
}
function prepare(binding, content, returnText = '') {
  if (!validBinding(binding)) throw new Error('当前记录或共享关系需要重新核对。')
  const key = binding.kind === 'daily' ? 'note' : 'content', limit = key === 'note' ? 500 : 2000
  if (!content || Object.keys(content).length !== 1 || typeof content[key] !== 'string' || !content[key].trim() || content[key].length > limit) {
    throw new Error(`请先把这段内容整理到${limit}字以内，再带入表单。`)
  }
  if (typeof returnText !== 'string' || returnText.length > 4000) throw new Error('待恢复的原话格式不正确。')
  const owner = identity(), privacy = require('./session-privacy')
  for (const map of [pending, returns]) {
    for (const [id, row] of map) if (Date.now() - row.at > LIMIT || row.owner !== owner || !privacy.isPatientSessionLeaseCurrent(row.lease)) map.delete(id)
    while (map.size >= 8) map.delete(map.keys().next().value)
  }
  const id = `companion-${Date.now().toString(36)}-${++serial}-${Math.random().toString(36).slice(2, 12)}`
  pending.set(id, { owner, lease: privacy.capturePatientSessionLease(), binding: canonical(binding), content: { [key]: content[key] }, at: Date.now() })
  if (returnText) returns.set(id, { owner, lease: privacy.capturePatientSessionLease(), patientId: binding.patientId, text: returnText, at: Date.now() })
  return id
}
function consume(id, binding) {
  const row = pending.get(id); pending.delete(id)
  if (!row) return null
  try {
    if (Date.now() - row.at > LIMIT || identity() !== row.owner || !require('./session-privacy').isPatientSessionLeaseCurrent(row.lease) ||
      !validBinding(binding) || canonical(binding) !== row.binding) return null
    return { ...row.content }
  } catch (_) { return null }
}
function discard(id) { pending.delete(id) }
function complete(id) { pending.delete(id); returns.delete(id) }
function recover(id, patientId) {
  const row = returns.get(id); complete(id)
  if (!row) return null
  try {
    if (row.patientId !== patientId || identity() !== row.owner || Date.now() - row.at > LIMIT ||
      !require('./session-privacy').isPatientSessionLeaseCurrent(row.lease)) return null
    return row.text
  } catch (_) { return null }
}
function clear() { pending.clear(); returns.clear() }
module.exports = { prepare, consume, discard, complete, recover, clear }
