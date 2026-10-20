const { decodeOriginalContext } = require('./original-context')
const KINDS = ['transfer_request', 'transfer_decision', 'transfer_work_action']
const positive = value => Number.isInteger(value) && value > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
const target = { acknowledge: 'acknowledged', resolve: 'resolved', close_with_reason: 'closed_with_reason' }
const status = { accept: 'accepted', reject: 'rejected', cancel: 'cancelled' }
const kindName = kind => kind === 'transfer_request' ? 'request' : kind === 'transfer_decision' ? 'decision' : 'work'
function original(item) {
  const name = kindName(item.kind), p = item.payload
  const token = p[name === 'work' ? 'action_context' : name + '_context']
  const value = decodeOriginalContext(token, `care-transfer-${name}-context`)
  return value && value.purpose === `care_transfer_${name}` && value.context_version === 1 && positive(value.actor_user_id) &&
    typeof value.actor_identity_basis === 'string' && value.actor_identity_basis && value.patient_id === p.patient_id &&
    Array.isArray(value.authorization_snapshot) && value.authorization_snapshot.length ? value : null
}
function valid(item, owner, canonical) {
  const p = item.payload, ctx = original(item)
  if (!ctx || ctx.actor_user_id !== owner.user_id || !digest(item.expected_context_digest) || p.confirmed !== true ||
    (p.reason !== null && (typeof p.reason !== 'string' || !p.reason.trim() || p.reason.length > 2000))) return false
  if (item.kind === 'transfer_request') return owner.role === 'patient' && p.client_transfer_id === item.id && positive(p.receiving_relationship_id) &&
    ctx.receiving_relationship_id === p.receiving_relationship_id && positive(ctx.receiver_doctor_user_id) &&
    Array.isArray(p.sources) && p.sources.length > 0 && p.sources.length <= 10 &&
    p.sources.every(s => ['attention', 'transferred_work'].includes(s.source_type) && positive(s.source_id) && positive(s.expected_version)) &&
    new Set(p.sources.map(s => `${s.source_type}:${s.source_id}`)).size === p.sources.length &&
    canonical(ctx.selected) === canonical(p.sources) && canonical(ctx.reason) === canonical(p.reason) &&
    Array.isArray(ctx.sources) && ctx.sources.length === p.sources.length
  if (item.kind === 'transfer_decision') return p.client_decision_id === item.id && positive(p.transfer_id) && p.transfer_id === ctx.transfer_id &&
    p.expected_version === 1 && ctx.expected_version === 1 && Array.isArray(ctx.allowed_decisions) && ctx.allowed_decisions.includes(p.decision) &&
    (owner.role === 'patient' ? p.decision === 'cancel' : ['accept', 'reject'].includes(p.decision)) && (p.decision === 'accept' || !!p.reason)
  return owner.role === 'researcher' && p.client_action_id === item.id && positive(p.work_item_id) && p.work_item_id === ctx.work_item_id &&
    positive(p.expected_version) && p.expected_version === ctx.expected_version && Object.prototype.hasOwnProperty.call(target, p.action) &&
    (p.action === 'acknowledge' ? ctx.previous_status === 'open' : p.action === 'resolve' ? ctx.previous_status === 'acknowledged' : ['open', 'acknowledged'].includes(ctx.previous_status)) &&
    (p.action === 'acknowledge' || !!p.reason)
}
function matches(item, ack, owner, canonical) {
  const ctx = original(item), p = item.payload
  if (!ctx || ctx.actor_user_id !== owner.user_id || !ack || ack.submission_status !== 'committed' || ack.legacy !== false ||
    ack.confirmed !== true || ack.patient_id !== p.patient_id || !digest(ack.payload_digest) ||
    canonical(ack.authorization_snapshot) !== canonical(ctx.authorization_snapshot) || ack.reason !== p.reason) return false
  if (item.kind === 'transfer_request') return positive(ack.id) && ack.client_transfer_id === p.client_transfer_id &&
    ack.author_user_id === ctx.actor_user_id && ack.author_identity_basis === ctx.actor_identity_basis &&
    ack.receiving_relationship_id === p.receiving_relationship_id && ack.receiver_doctor_user_id === ctx.receiver_doctor_user_id &&
    ack.request_context_digest === item.expected_context_digest && ack.version === 1 && ack.status === 'pending_acceptance' &&
    ack.status_snapshot_at_creation === true && canonical(ack.sources) === canonical(ctx.sources) && time(ack.requested_at)
  if (ack.actor_user_id !== ctx.actor_user_id || ack.actor_identity_basis !== ctx.actor_identity_basis || ack.expected_version !== p.expected_version) return false
  if (item.kind === 'transfer_decision') return positive(ack.id) && ack.client_decision_id === p.client_decision_id &&
    ack.transfer_id === p.transfer_id && ack.decision === p.decision && ack.decision_context_digest === item.expected_context_digest &&
    ack.version === 2 && ack.status === status[p.decision] && Array.isArray(ack.work_item_ids) &&
    ack.work_item_ids.every(positive) && new Set(ack.work_item_ids).size === ack.work_item_ids.length &&
    ack.work_item_ids.length === (p.decision === 'accept' ? ctx.source_count : 0) && time(ack.decided_at)
  return positive(ack.action_id) && ack.client_action_id === p.client_action_id && ack.work_item_id === p.work_item_id &&
    ack.action === p.action && ack.previous_status === ctx.previous_status && ack.status === target[p.action] &&
    ack.version === p.expected_version + 1 && ack.action_context_digest === item.expected_context_digest && time(ack.occurred_at)
}
const queryRoute = kind => kind === 'transfer_request' ? '/care/responsibility-transfers/submissions/' :
  kind === 'transfer_decision' ? '/care/responsibility-transfer-decisions/' : '/care/transferred-work-actions/'
function conflict(a, b) {
  if (!KINDS.includes(a.kind) || a.kind !== b.kind) return false
  if (a.kind === 'transfer_decision') return a.payload.transfer_id === b.payload.transfer_id
  if (a.kind === 'transfer_work_action') return a.payload.work_item_id === b.payload.work_item_id && a.payload.expected_version === b.payload.expected_version
  return a.payload.patient_id === b.payload.patient_id && a.payload.sources.some(s => b.payload.sources.some(t => t.source_type === s.source_type && t.source_id === s.source_id))
}
module.exports = { KINDS, original, valid, matches, conflict, queryRoute }
