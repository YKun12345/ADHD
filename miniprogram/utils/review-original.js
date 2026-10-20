const { decodeOriginalContext } = require('./original-context')
const clarification = require('./clarification-original')
const plan = require('./plan-original')
const KINDS = ['review_draft', 'review_publication', ...clarification.KINDS, ...plan.KINDS]
const positive = value => Number.isInteger(value) && value > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const actual = value => typeof value === 'string' && value.trim().length > 0
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
function original(item) {
  const publication = item.kind === 'review_publication', p = item.payload
  const value = decodeOriginalContext(p[publication ? 'publication_context' : 'review_context'], publication ? 'review-publication-context' : 'doctor-review-context')
  return value && value.context_version === 1 && value.purpose === (publication ? 'review_publication' : 'doctor_review_context') &&
    positive(value.actor_user_id) && actual(value.actor_identity_basis) && value.patient_id === p.patient_id && value.assessment_id === p.assessment_id &&
    value.input_digest === p.input_digest && Array.isArray(value.authorization_snapshot) && value.authorization_snapshot.length ? value : null
}
function valid(item, owner, canonical) {
  if (plan.KINDS.includes(item.kind)) return plan.valid(item, owner, canonical)
  if (clarification.KINDS.includes(item.kind)) return clarification.valid(item, owner, canonical)
  const p = item.payload, ctx = original(item), publication = item.kind === 'review_publication'
  if (!ctx || owner.role !== 'researcher' || ctx.actor_user_id !== owner.user_id || !digest(item.expected_context_digest) ||
    !digest(p.input_digest) || !positive(p.assessment_id) || !positive(p.expected_assessment_version) || p.confirmed !== true || item.id.length > 64) return false
  if (publication) {
    const review = item.expected_review
    return p.client_publication_id === item.id && positive(p.review_id) && p.review_id === ctx.review_id &&
      p.expected_assessment_version === ctx.expected_assessment_version && Number.isInteger(p.expected_previous_report_version) && p.expected_previous_report_version >= 0 &&
      p.expected_previous_report_version === ctx.expected_previous_report_version && review && review.id === p.review_id &&
      digest(review.payload_digest) && review.payload_digest === ctx.review_payload_digest && actual(review.body) && actual(review.limitations) && Array.isArray(review.decisions)
  }
  return p.client_review_id === item.id && p.expected_assessment_version === ctx.assessment_version && ctx.responsible_doctor_id === owner.user_id &&
    ['evidence_review', 'screening_opinion'].includes(p.category) && actual(p.body) && p.body.length <= 12000 && actual(p.limitations) && p.limitations.length <= 4000 &&
    Array.isArray(p.decisions) && p.decisions.length > 0 && p.decisions.length <= 100 && new Set(p.decisions.map(row => row.submission_id)).size === p.decisions.length &&
    p.decisions.every(row => actual(row.submission_id) && positive(row.assessment_item_id) && positive(row.attempt_id) &&
      ['accepted', 'needs_repeat', 'rejected'].includes(row.decision) && actual(row.reason) && row.reason.length <= 2000)
}
function matches(item, ack, owner, canonical) {
  if (plan.KINDS.includes(item.kind)) return plan.matches(item, ack, owner, canonical)
  if (clarification.KINDS.includes(item.kind)) return clarification.matches(item, ack, owner, canonical)
  const ctx = original(item), p = item.payload, publication = item.kind === 'review_publication'
  if (!ctx || !ack || ctx.actor_user_id !== owner.user_id || !positive(ack.id) || ack.actor_user_id !== ctx.actor_user_id ||
    ack.actor_identity_basis !== ctx.actor_identity_basis || ack.patient_id !== p.patient_id || ack.assessment_id !== p.assessment_id ||
    ack.input_digest !== p.input_digest || ack.expected_assessment_version !== p.expected_assessment_version || !digest(ack.payload_digest) ||
    ack.submission_status !== 'committed' || ack.legacy !== false || ack.confirmed !== true || typeof ack.demonstration_only !== 'boolean' ||
    canonical(ack.authorization_snapshot) !== canonical(ctx.authorization_snapshot)) return false
  const source = publication ? item.expected_review : p
  if (!source) return false
  if ((ack.source_ai_decision_id == null ? null : ack.source_ai_decision_id) !== (source.source_ai_decision_id == null ? null : source.source_ai_decision_id)) return false
  if (!source || ['category', 'body', 'limitations', 'decisions'].some(field => canonical(ack[field]) !== canonical(source[field]))) return false
  if (!publication) return ack.client_review_id === p.client_review_id && ack.status === 'draft' &&
    ack.review_context_digest === item.expected_context_digest && time(ack.created_at)
  return ack.client_publication_id === p.client_publication_id && ack.review_id === p.review_id && ack.review_payload_digest === ctx.review_payload_digest &&
    ack.status === 'published' && ack.version === p.expected_previous_report_version + 1 &&
    ack.expected_previous_report_version === p.expected_previous_report_version && ack.assessment_version === p.expected_assessment_version + 1 &&
    ack.publication_context_digest === item.expected_context_digest && time(ack.published_at)
}
const queryRoute = kind => plan.KINDS.includes(kind) ? plan.queryRoute(kind) : clarification.KINDS.includes(kind) ? clarification.queryRoute(kind) : kind === 'review_draft' ? '/care/reviews/submissions/' : '/care/review-publications/submissions/'
module.exports = { KINDS, valid, matches, original, queryRoute }
