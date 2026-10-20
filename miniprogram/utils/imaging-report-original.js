const { decodeOriginalContext } = require('./original-context')
const positive = value => Number.isInteger(value) && value > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const original = item => decodeOriginalContext(item.payload.publication_context, 'imaging-report-publication')
function valid(item, owner) {
  const p = item.payload, c = original(item)
  return c && owner.role === 'researcher' && c.purpose === 'imaging_report_publication' && c.context_version === 1 && c.actor_user_id === owner.user_id &&
    positive(p.patient_id) && positive(p.prediction_id) && positive(p.expected_previous_version) && p.patient_id === c.patient_id && p.prediction_id === c.prediction_id &&
    p.expected_previous_version === c.expected_previous_version && p.input_digest === c.input_digest && digest(p.input_digest) && digest(item.expected_context_digest) &&
    p.client_publication_id === item.id && item.id.length <= 64 && p.confirmed === true &&
    typeof p.body === 'string' && p.body.trim() && p.body.length <= 8000 && typeof p.limitations === 'string' && p.limitations.trim() && p.limitations.length <= 4000 &&
    Array.isArray(c.authorization_snapshot) && c.authorization_snapshot.length
}
function matches(item, ack, owner, canonical) {
  const p = item.payload, c = original(item)
  return c && ack && positive(ack.id) && ack.actor_user_id === owner.user_id && ack.patient_id === p.patient_id && ack.prediction_id === p.prediction_id &&
    ack.client_publication_id === item.id && ack.version === p.expected_previous_version + 1 && ack.publisher_kind === 'doctor' &&
    ack.professional_review_status === 'reviewed' && ack.status === 'published' && ack.submission_status === 'committed' && ack.legacy === false && ack.confirmed === true &&
    ack.body === p.body && ack.limitations === p.limitations && ack.input_digest === p.input_digest && digest(ack.payload_digest) &&
    ack.publication_context_digest === item.expected_context_digest && canonical(ack.authorization_snapshot) === canonical(c.authorization_snapshot) && canonical(ack.original_request) === canonical(p)
}
module.exports = { valid, matches, original }
