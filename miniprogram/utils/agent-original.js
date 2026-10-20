const { decodeOriginalContext } = require('./original-context')
const { POLICY, validPreview } = require('./companion-dialogue')
const positive = value => Number.isInteger(value) && value > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function valid(item, owner) {
  const p = item.payload, ctx = decodeOriginalContext(p.run_context, 'unified-agent-run-context')
  const consent = p.external_message_consent
  if (consent != null && (p.intent !== 'question' || consent.confirmed !== true || !['Xingzai-current-message-1', POLICY].includes(consent.version) ||
    Object.keys(consent).length !== 2 || !ctx || ctx.question_mode !== 'smart' || !ctx.external_ai || ctx.external_ai.field_policy_version !== consent.version)) return false
  if (ctx && ctx.question_mode === 'smart' && !consent) return false
  if (consent?.version === POLICY) {
    if (!validPreview(ctx.conversation_preview, p.context_run_ids)) return false
  } else if (p.context_run_ids != null && (!Array.isArray(p.context_run_ids) || p.context_run_ids.length)) return false
  return ctx && ctx.purpose === 'unified_agent_run' && ctx.context_version === 1 && ctx.actor_user_id === owner.user_id && ctx.role === owner.role &&
    ctx.patient_id === p.patient_id && ctx.input_digest === p.expected_context_digest && Array.isArray(ctx.authorization_snapshot) && ctx.authorization_snapshot.length &&
    p.client_run_id === item.id && item.id.length <= 64 && positive(p.patient_id) && digest(p.expected_context_digest) && digest(item.expected_context_digest) &&
    ['question', 'assessment_summary', 'cycle_summary', 'review_questions', 'plan_draft', 'reply_draft', 'profile_fields'].includes(p.intent) &&
    typeof p.message === 'string' && p.message.trim().length > 0 && p.message.length <= 4000 &&
    (p.assessment_id === null || positive(p.assessment_id)) && (p.cycle_id === null || positive(p.cycle_id))
}
function matches(item, ack, owner, canonical) {
  const p = item.payload
  return ack && positive(ack.run_id) && ack.id === ack.run_id && ack.actor_user_id === owner.user_id && ack.patient_id === p.patient_id &&
    ack.client_run_id === item.id && ack.input_digest === p.expected_context_digest && ack.run_context_digest === item.expected_context_digest &&
    digest(ack.request_digest) && ack.accepted === true && ack.submission_status === 'committed' && ack.legacy === false &&
    canonical(ack.original_request) === canonical(p) && typeof ack.requested_at === 'string' &&
    /(Z|[+-]\d{2}:\d{2})$/.test(ack.requested_at) && Number.isFinite(Date.parse(ack.requested_at))
}
module.exports = { valid, matches }
