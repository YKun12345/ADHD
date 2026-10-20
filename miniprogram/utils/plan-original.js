const { decodeOriginalContext } = require('./original-context')
const KINDS = ['plan_publication', 'plan_received']
const positive = value => Number.isInteger(value) && value > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const actual = value => typeof value === 'string' && value.trim().length > 0
const time = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
function original(item) {
  const received = item.kind === 'plan_received', p = item.payload
  const ctx = decodeOriginalContext(p[received ? 'acknowledgement_context' : 'plan_context'], received ? 'care-plan-received-context' : 'care-plan-context')
  return ctx && ctx.context_version === 1 && ctx.purpose === (received ? 'care_plan_received' : 'care_plan_publication') &&
    positive(ctx.actor_user_id) && actual(ctx.actor_identity_basis) && ctx.patient_id === p.patient_id && ctx.assessment_id === p.assessment_id &&
    Array.isArray(ctx.authorization_snapshot) && ctx.authorization_snapshot.length ? ctx : null
}
function valid(item, owner) {
  const received = item.kind === 'plan_received', p = item.payload, ctx = original(item)
  if (!ctx || ctx.actor_user_id !== owner.user_id || owner.role !== (received ? 'patient' : 'researcher') || !digest(item.expected_context_digest) ||
    !positive(p.patient_id) || !positive(p.assessment_id) || p.confirmed !== true || item.id.length > 64) return false
  if (received) return p.client_acknowledgement_id === item.id && positive(p.plan_version_id) && ctx.plan_version_id === p.plan_version_id &&
    digest(ctx.plan_payload_digest) && positive(ctx.version) && positive(ctx.plan_revision)
  return p.client_plan_version_id === item.id && p.expected_assessment_version === ctx.assessment_version &&
    p.expected_previous_version === ctx.expected_previous_version && p.expected_plan_revision === ctx.expected_plan_revision &&
    Number.isInteger(p.expected_previous_version) && p.expected_previous_version >= 0 && Number.isInteger(p.expected_plan_revision) && p.expected_plan_revision >= 0 &&
    positive(p.source_report_id) && p.source_report_id === ctx.source_report_id && digest(p.input_digest) && p.input_digest === ctx.input_digest &&
    actual(p.title) && p.title.length <= 120 && actual(p.instructions) && p.instructions.length <= 4000 &&
    /^\d{4}-\d{2}-\d{2}$/.test(p.start_date) && /^\d{4}-\d{2}-\d{2}$/.test(p.end_date)
}
function matches(item, ack, owner, canonical) {
  const p = item.payload, ctx = original(item), received = item.kind === 'plan_received'
  if (!ctx || !ack || !positive(ack.id) || ack.actor_user_id !== owner.user_id || ack.actor_identity_basis !== ctx.actor_identity_basis ||
    ack.submission_status !== 'committed' || ack.legacy !== false || !digest(ack.payload_digest) ||
    canonical(ack.authorization_snapshot) !== canonical(ctx.authorization_snapshot)) return false
  const fields = received ? ['client_acknowledgement_id', 'plan_version_id'] : ['client_plan_version_id', 'expected_assessment_version',
    'expected_previous_version', 'expected_plan_revision', 'source_report_id', 'input_digest', 'title', 'instructions', 'start_date', 'end_date']
  if (!['patient_id', 'assessment_id', 'confirmed', ...fields].every(key => canonical(ack[key]) === canonical(p[key]))) return false
  if (received) return ack.version === ctx.version && ack.meaning === 'received_only' &&
    ack.acknowledgement_context_digest === item.expected_context_digest && time(ack.received_at)
  if ((ack.source_ai_decision_id == null ? null : ack.source_ai_decision_id) !== (p.source_ai_decision_id == null ? null : p.source_ai_decision_id)) return false
  return positive(ack.plan_id) && positive(ack.cycle_id) && ack.version === p.expected_previous_version + 1 &&
    ack.plan_revision === p.expected_plan_revision + 1 && ack.assessment_version === p.expected_assessment_version + 1 &&
    ack.status === 'published' && ack.task_type === 'daily_record' && typeof ack.demonstration_only === 'boolean' &&
    ack.plan_context_digest === item.expected_context_digest && time(ack.published_at)
}
const queryRoute = kind => kind === 'plan_publication' ? '/care/plan-versions/submissions/' : '/care/plan-acknowledgements/submissions/'
module.exports = { KINDS, original, valid, matches, queryRoute }
