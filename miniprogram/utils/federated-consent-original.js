// These checks bind a durable operation receipt to its exact original. They do
// not establish current consent; always reload the project's consent context.
const KINDS = ['federated_consent', 'federated_consent_withdraw']
const SCOPES = ['profile', 'assessment', 'tracking', 'care', 'imaging']
const positive = value => Number.isSafeInteger(value) && value > 0
const instant = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
function projectId(item) {
  const match = item && typeof item.route === 'string' && item.route.match(/^\/federated\/projects\/([1-9]\d*)\/consent(?:\/withdraw)?$/)
  return match && positive(Number(match[1])) ? Number(match[1]) : 0
}
function route(item) {
  if (!item || !KINDS.includes(item.kind) || !projectId(item)) return null
  return `/federated/projects/${projectId(item)}/consent${item.kind === 'federated_consent_withdraw' ? '/withdraw' : ''}`
}
function valid(item, owner) {
  const p = item.payload
  if (!p || owner.role !== 'patient' || !positive(owner.user_id) || !positive(p.patient_id) ||
      typeof item.id !== 'string' || !item.id.trim() || item.id.length > 64 || p.client_request_id !== item.id || item.route !== route(item)) return false
  if (item.kind === 'federated_consent_withdraw') return Object.keys(p).every(key =>
    ['client_request_id', 'patient_id', 'consent_id', 'expected_revision'].includes(key)) && positive(p.consent_id) && positive(p.expected_revision)
  return Object.keys(p).every(key => ['client_request_id', 'patient_id', 'project_id', 'expected_project_revision', 'purpose', 'scope', 'terms_version', 'expires_at', 'target_user_id'].includes(key)) &&
    p.project_id === projectId(item) && positive(p.expected_project_revision) && p.purpose === 'research' && p.terms_version === 'W02-1' && Array.isArray(p.scope) && p.scope.length > 0 && p.scope.length <= SCOPES.length &&
    new Set(p.scope).size === p.scope.length && p.scope.every(key => SCOPES.includes(key)) &&
    (p.target_user_id === undefined || p.target_user_id === null) && (p.expires_at === undefined || p.expires_at === null || instant(p.expires_at))
}
function matches(item, ack, owner, canonical) {
  if (!valid(item, owner) || !ack || typeof ack.id !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(ack.id) ||
      ack.actor_user_id !== owner.user_id || ack.client_request_id !== item.id || ack.submission_status !== 'committed' ||
      canonical(ack.original_request) !== canonical(item.payload)) return false
  const p = item.payload, r = ack.result
  if (!r || !positive(r.id) || r.patient_id !== p.patient_id || r.project_id !== projectId(item) || r.purpose !== 'research' || !positive(r.revision)) return false
  if (item.kind === 'federated_consent_withdraw') return r.id === p.consent_id && r.status === 'withdrawn' && r.revision === p.expected_revision + 1
  return r.status === 'active' && r.project_revision === p.expected_project_revision && r.grantor_user_id === owner.user_id && r.terms_version === p.terms_version &&
    Array.isArray(r.scope) && canonical([...r.scope].sort()) === canonical([...p.scope].sort()) &&
    (p.expires_at == null ? r.expires_at === null : instant(r.expires_at) && Date.parse(r.expires_at) === Date.parse(p.expires_at))
}
module.exports = { KINDS, SCOPES, projectId, route, valid, matches }
