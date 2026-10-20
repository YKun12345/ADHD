const { decodeOriginalContext } = require('./original-context')
const positive = value => Number.isInteger(value) && value > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function valid(item, owner) {
  const p = item.payload, ctx = decodeOriginalContext(p.decision_context, 'artifact-decision-context')
  return ctx && ctx.purpose === 'artifact_decision' && ctx.context_version === 1 && ctx.actor_user_id === owner.user_id &&
    ctx.patient_id === p.patient_id && ctx.artifact_id === p.artifact_id && positive(p.patient_id) && positive(p.artifact_id) &&
    p.client_decision_id === item.id && item.id.length <= 64 && p.expected_previous_version === ctx.expected_previous_version &&
    Number.isInteger(p.expected_previous_version) && p.expected_previous_version >= 0 && digest(item.expected_context_digest) &&
    digest(ctx.input_digest) && digest(ctx.artifact_body_digest) && digest(ctx.artifact_source_digest) &&
    Array.isArray(ctx.authorization_snapshot) && ctx.authorization_snapshot.length &&
    (owner.role === 'researcher' || owner.role === 'patient' && ['profile_fields','cycle_summary'].includes(ctx.artifact_kind)
      ? ['adopt','edit','reject'] : owner.role === 'patient' ? ['reject'] : []).includes(p.decision) &&
    typeof p.reason === 'string' && p.reason.trim() && p.reason.length <= 2000 && p.confirmed === true &&
    (p.decision === 'reject' ? p.content === null : p.content && typeof p.content === 'object' && !Array.isArray(p.content))
}
function matches(item, ack, owner, canonical) {
  const p = item.payload, ctx = decodeOriginalContext(p.decision_context, 'artifact-decision-context')
  return ctx && ack && positive(ack.id) && ack.actor_user_id === owner.user_id && ack.actor_identity_basis === ctx.actor_identity_basis &&
    ack.patient_id === p.patient_id && ack.artifact_id === p.artifact_id && ack.client_decision_id === item.id &&
    ack.input_digest === ctx.input_digest && ack.version === p.expected_previous_version + 1 && ack.decision === p.decision &&
    ack.decision_context_digest === item.expected_context_digest && digest(ack.payload_digest) &&
    ack.submission_status === 'committed' && ack.legacy === false && ack.confirmed === true &&
    canonical(ack.authorization_snapshot) === canonical(ctx.authorization_snapshot) && canonical(ack.original_request) === canonical(p) &&
    (p.decision === 'reject' ? ack.target_type === null && ack.target_client_id === null && ack.content === null :
      ['review_question','plan_publication','shared_message','review_draft','assessment_background','cycle_review'].includes(ack.target_type) && /^ai-use-[a-f0-9]{40}$/.test(ack.target_client_id) && canonical(ack.content) === canonical(p.content)) &&
    typeof ack.created_at === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(ack.created_at) && Number.isFinite(Date.parse(ack.created_at))
}
module.exports = { valid, matches }
