const { decodeOriginalContext } = require('./original-context')
const positive = value => Number.isInteger(value) && value > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max
function original(item) { return decodeOriginalContext(item.payload.review_context, 'cycle-review-context') }
function valid(item, owner) {
  const p = item.payload, ctx = original(item)
  return ctx && ctx.purpose === 'cycle_review' && ctx.context_version === 1 && ctx.actor_user_id === owner.user_id &&
    ['self', 'professional'].includes(ctx.cycle_type) && owner.role === (ctx.cycle_type === 'self' ? 'patient' : 'researcher') &&
    ctx.patient_id === p.patient_id && ctx.cycle_id === p.cycle_id && ctx.input_digest === p.input_digest &&
    ctx.expected_previous_version === p.expected_previous_version && p.expected_previous_version === 0 &&
    positive(p.patient_id) && positive(p.cycle_id) && digest(p.input_digest) && digest(item.expected_context_digest) &&
    Array.isArray(ctx.authorization_snapshot) && ctx.authorization_snapshot.length && p.client_cycle_review_id === item.id && item.id.length <= 64 &&
    text(p.body, 8000) && text(p.limitations, 2000) && text(p.reason, 2000) && p.confirmed === true &&
    (ctx.cycle_type === 'self' ? ['end', 'next_round'] : ['continue', 'adjust', 'end', 'next_round']).includes(p.decision) &&
    (['continue', 'adjust'].includes(p.decision) ? p.followup_plan && text(p.followup_plan.title, 120) && text(p.followup_plan.instructions, 4000) &&
      /^\d{4}-\d{2}-\d{2}$/.test(p.followup_plan.start_date) && /^\d{4}-\d{2}-\d{2}$/.test(p.followup_plan.end_date) : p.followup_plan === null)
}
function matches(item, ack, owner, canonical) {
  const ctx = original(item), p = item.payload
  return ctx && ack && positive(ack.id) && ack.actor_user_id === owner.user_id && ack.actor_identity_basis === ctx.actor_identity_basis &&
    ack.patient_id === p.patient_id && ack.cycle_id === p.cycle_id && ack.client_cycle_review_id === item.id &&
    ack.input_digest === p.input_digest && ack.version === p.expected_previous_version + 1 && ack.decision === p.decision &&
    ack.review_context_digest === item.expected_context_digest && digest(ack.payload_digest) && ack.confirmed === true &&
    ack.submission_status === 'committed' && ack.legacy === false && ack.cycle_type === ctx.cycle_type &&
    ack.professional_confirmation === (ctx.cycle_type === 'professional') && canonical(ack.original_request) === canonical(p) &&
    canonical(ack.authorization_snapshot) === canonical(ctx.authorization_snapshot) &&
    [ack.next_cycle_id, ack.next_plan_version_id, ack.next_assessment_id].every(value => value === null || positive(value)) &&
    typeof ack.created_at === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(ack.created_at) && Number.isFinite(Date.parse(ack.created_at))
}
module.exports = { valid, matches, original }
