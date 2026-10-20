const { decodeOriginalContext } = require('./original-context')
const KINDS = ['review_question', 'clarification_reply']
const positive = value => Number.isInteger(value) && value > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const actual = value => typeof value === 'string' && value.trim().length > 0
function original(item) {
  const reply = item.kind === 'clarification_reply', p = item.payload
  const ctx = decodeOriginalContext(p[reply ? 'reply_context' : 'review_context'], reply ? 'clarification-reply-context' : 'doctor-review-context')
  return ctx && ctx.context_version === 1 && ctx.purpose === (reply ? 'clarification_reply' : 'doctor_review_context') &&
    positive(ctx.actor_user_id) && actual(ctx.actor_identity_basis) && ctx.patient_id === p.patient_id && ctx.assessment_id === p.assessment_id &&
    ctx.assessment_version === p.expected_assessment_version && Array.isArray(ctx.authorization_snapshot) && ctx.authorization_snapshot.length ? ctx : null
}
function valid(item, owner) {
  const reply = item.kind === 'clarification_reply', p = item.payload, ctx = original(item)
  if (!ctx || ctx.actor_user_id !== owner.user_id || owner.role !== (reply ? 'patient' : 'researcher') || !digest(item.expected_context_digest) ||
    p.confirmed !== true || !positive(p.patient_id) || !positive(p.assessment_id) || item.id.length > 64) return false
  if (reply) return p.client_reply_id === item.id && positive(p.question_id) && p.question_id === ctx.question_id &&
    Number.isInteger(p.expected_previous_revision) && p.expected_previous_revision >= 0 && p.expected_previous_revision === ctx.expected_previous_revision &&
    digest(ctx.question_payload_digest) && ['provided', 'unknown', 'skipped'].includes(p.answer_status) &&
    (p.answer_status === 'provided' ? actual(p.answer) && p.answer.length <= 4000 : p.answer === null)
  return p.client_question_id === item.id && ctx.responsible_doctor_id === owner.user_id && p.input_digest === ctx.input_digest &&
    (p.source_ai_decision_id == null || positive(p.source_ai_decision_id)) &&
    digest(p.input_digest) && ['submission', 'background'].includes(p.source_type) && actual(p.source_key) && p.source_key.length <= 64 &&
    actual(p.question) && p.question.length <= 2000
}
function matches(item, ack, owner, canonical) {
  const p = item.payload, ctx = original(item), reply = item.kind === 'clarification_reply'
  if (!ctx || !ack || !positive(ack.id) || ack.actor_user_id !== owner.user_id || ack.actor_identity_basis !== ctx.actor_identity_basis ||
    ack.submission_status !== 'committed' || ack.legacy !== false || !digest(ack.payload_digest) ||
    ack.assessment_version !== p.expected_assessment_version + 1 || ack.status !== (reply ? 'answered' : 'requested') ||
    canonical(ack.authorization_snapshot) !== canonical(ctx.authorization_snapshot) ||
    typeof ack.created_at !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(ack.created_at) || !Number.isFinite(Date.parse(ack.created_at))) return false
  const fields = reply ? ['client_reply_id', 'question_id', 'expected_previous_revision', 'answer_status', 'answer']
    : ['client_question_id', 'input_digest', 'source_type', 'source_key', 'question']
  return ['patient_id', 'assessment_id', 'expected_assessment_version', 'confirmed', ...fields].every(key => canonical(ack[key]) === canonical(p[key])) &&
    ack[reply ? 'reply_context_digest' : 'review_context_digest'] === item.expected_context_digest &&
    (!reply || ack.revision === p.expected_previous_revision + 1) &&
    (reply || (ack.source_ai_decision_id == null ? null : ack.source_ai_decision_id) === (p.source_ai_decision_id == null ? null : p.source_ai_decision_id))
}
const queryRoute = kind => kind === 'review_question' ? '/care/clarifications/submissions/' : '/care/clarification-replies/submissions/'
module.exports = { KINDS, original, valid, matches, queryRoute }
