const { request } = require('./request')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('./session-privacy')
const transfer = require('./transfer-original')
const review = require('./review-original')

const QUEUE_KEY = 'submission_queue_v1'
const MAX_ENTRIES = 50
const MAX_BYTES = 2 * 1024 * 1024
const ROUTES = Object.freeze({ assessment: '/care/submissions', legacy_cognitive: '/patient/submit_cognitive_test', cycle_daily: '/care/daily-records', cycle_create: '/care/cycles', shared_message: '/care/shared-messages', attention_action: '/care/attention-actions', service_coverage: '/identity/service-coverage-versions', transfer_request: '/care/responsibility-transfers', transfer_decision: '/care/responsibility-transfer-decisions', transfer_work_action: '/care/transferred-work-actions', review_draft: '/care/reviews', review_publication: '/care/review-publications', review_question: '/care/clarifications', clarification_reply: '/care/clarification-replies', plan_publication: '/care/plan-versions', plan_received: '/care/plan-acknowledgements', agent_run: '/agent/runs', cycle_review: '/care/cycle-reviews', artifact_decision: '/agent/artifact-decisions', imaging_report: '/care/imaging-reports' })
const agent = require('./agent-original')
const artifactDecision = require('./artifact-decision-original')
const cycleReview = require('./cycle-review-original')
const imagingReport = require('./imaging-report-original')
const federatedConsent = require('./federated-consent-original')
const routeFor = item => federatedConsent.KINDS.includes(item.kind) ? federatedConsent.route(item) : ROUTES[item.kind]
const inFlight = new Set()
const positive = value => Number.isInteger(value) && value > 0
function error(message, code = 'QUEUE_STORAGE_FAILED') { return Object.assign(new Error(message), { code }) }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  throw error('提交负载包含不能保存的内容。', 'QUEUE_INVALID_PAYLOAD')
}
const copy = value => JSON.parse(canonical(value))
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const doctorQueueKind = kind => ['shared_message', 'attention_action', 'service_coverage', 'transfer_decision', 'transfer_work_action', 'agent_run', 'cycle_review', 'artifact_decision', 'imaging_report', ...review.KINDS].includes(kind)
const { decodeOriginalContext } = require('./original-context')
const COVERAGE_FIELDS = ['timezone', 'working_periods', 'expected_response_working_minutes', 'approved_process_reference', 'escalation_instructions']
function originalCoverageContext(item) {
  const value = decodeOriginalContext(item.payload.configuration_context, 'service-coverage-context')
  return value && value.purpose === 'service_coverage' && positive(value.actor_user_id) &&
    value.doctor_user_id === item.payload.doctor_user_id && value.institution_id === item.payload.institution_id &&
    value.expected_previous_version === item.payload.expected_previous_version && Array.isArray(value.credential_snapshot) ? value : null
}
const ACTION_STATUSES = Object.freeze({ acknowledge: 'acknowledged', resolve: 'resolved', close_with_reason: 'closed_with_reason' })
function originalAttentionContext(item) {
  // Consistency only: authority and the signature are always verified by the server.
  try {
    const parts = item.payload.action_context.split('.')
    if (parts.length !== 4 || parts[0] !== 'attention-action-context' || parts[1] !== 'v1' ||
      !/^[A-Za-z0-9_-]+$/.test(parts[2]) || parts[2].length % 4 === 1 || !digest(parts[3])) return null
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let buffer = 0, bits = 0, encoded = ''
    for (const character of parts[2]) {
      buffer = buffer * 64 + alphabet.indexOf(character); bits += 6
      if (bits >= 8) {
        bits -= 8; encoded += '%' + ('0' + ((buffer >> bits) & 255).toString(16)).slice(-2)
        buffer &= (1 << bits) - 1
      }
    }
    const value = JSON.parse(decodeURIComponent(encoded))
    return value.purpose === 'attention_action' && value.version === 1 && positive(value.actor_user_id) &&
      typeof value.actor_identity_basis === 'string' && value.actor_identity_basis &&
      value.patient_id === item.payload.patient_id && value.attention_id === item.payload.attention_id &&
      value.expected_version === item.payload.expected_version && ['open', 'acknowledged'].includes(value.previous_status) &&
      Array.isArray(value.authorization_snapshot) ? value : null
  } catch (_) { return null }
}
function originalSharedParties(item) {
  // Decode only the immutable original's metadata. The server verifies its MAC;
  // this client check never grants authority or substitutes a current relation.
  try {
    const parts = item.payload.send_context.split('.')
    if (parts.length !== 4 || parts[0] !== 'shared-message-context' || parts[1] !== 'v1' ||
      !/^[A-Za-z0-9_-]+$/.test(parts[2]) || parts[2].length % 4 === 1 || !digest(parts[3])) return null
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let buffer = 0, bits = 0, encoded = ''
    for (const character of parts[2]) {
      buffer = buffer * 64 + alphabet.indexOf(character); bits += 6
      if (bits >= 8) {
        bits -= 8; encoded += '%' + ('0' + ((buffer >> bits) & 255).toString(16)).slice(-2)
        buffer &= (1 << bits) - 1
      }
    }
    const value = JSON.parse(decodeURIComponent(encoded))
    return value.purpose === 'shared_message_send' && value.version === 1 &&
      value.patient_id === item.payload.patient_id && value.relationship_id === item.payload.relationship_id &&
      value.relationship_revision === item.expected_relationship_revision && positive(value.doctor_user_id) &&
      positive(value.patient_actor_user_id) && typeof value.sender_identity_basis === 'string' && value.sender_identity_basis
      ? value : null
  } catch (_) { return null }
}
function fingerprintFor(item) {
  if (federatedConsent.KINDS.includes(item.kind)) return canonical({ payload: item.payload, route: item.route })
  if (['agent_run', 'cycle_review', 'artifact_decision', 'imaging_report'].includes(item.kind)) return canonical({ payload: item.payload, expected_context_digest: item.expected_context_digest })
  if (review.KINDS.includes(item.kind)) return canonical({ payload: item.payload, expected_context_digest: item.expected_context_digest,
    ...(item.kind === 'review_publication' ? { expected_review: item.expected_review } : {}) })
  if (item.kind === 'shared_message') return canonical({ payload: item.payload, expected_context_digest: item.expected_context_digest,
    expected_relationship_revision: item.expected_relationship_revision })
  return ['attention_action', 'service_coverage', ...transfer.KINDS].includes(item.kind) ? canonical({ payload: item.payload, expected_context_digest: item.expected_context_digest }) : canonical(item.payload)
}
function owner() {
  let user, lease
  try { user = wx.getStorageSync('current_user'); lease = capturePatientSessionLease() } catch (_) { throw error('无法读取当前账号，请重新登录。') }
  if (!user || !positive(user.id) || !['patient', 'researcher'].includes(user.role) || !isPatientSessionLeaseCurrent(lease)) throw error('当前会话不能提交资料。', 'SESSION_CHANGED')
  return { user_id: user.id, role: user.role, api_base_url: lease.apiBaseUrl }
}
const sameOwner = (a, b) => a && b && canonical(a) === canonical(b)
function utf8Size(value) {
  let bytes = 0
  for (const character of value) { const code = character.codePointAt(0); bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4 }
  return bytes
}
function readStore() {
  let value
  try { value = wx.getStorageSync(QUEUE_KEY) } catch (_) { throw error('待同步数据读取失败，请保留当前页面并重试。') }
  if (value === '' || value === undefined || value === null) return null
  if (!value || value.version !== 1 || !value.owner || !Array.isArray(value.entries)) throw error('待同步数据格式异常，不能自动提交。', 'QUEUE_CORRUPT')
  const ids = new Set()
  for (const item of value.entries) {
    if (!item || typeof item.id !== 'string' || ids.has(item.id) || routeFor(item) !== item.route || item.fingerprint !== fingerprintFor(item) ||
      (value.owner.role !== 'patient' && !doctorQueueKind(item.kind))) throw error('待同步数据已变化，不能自动提交。', 'QUEUE_CORRUPT')
    ids.add(item.id)
  }
  return copy(value)
}
function ownedStore(currentOwner) {
  const stored = readStore()
  if (stored && !sameOwner(stored.owner, currentOwner)) throw error('待同步内容属于另一账号或服务器，请先退出原会话。', 'SESSION_CHANGED')
  return stored || { version: 1, owner: currentOwner, entries: [] }
}
function persist(value) {
  const serialized = canonical(value)
  if (utf8Size(serialized) > MAX_BYTES) throw error('本机待同步队列容量已满，请先同步已有内容。', 'QUEUE_FULL')
  try {
    if (wx.setStorageSync(QUEUE_KEY, copy(value)) === false) throw new Error('write rejected')
    if (canonical(wx.getStorageSync(QUEUE_KEY)) !== serialized) throw new Error('readback mismatch')
  } catch (_) { throw error('待同步内容保存失败，请保留当前页面并重试。') }
}
function enqueue(candidate) {
  const currentOwner = owner(), store = ownedStore(currentOwner)
  if (!candidate || typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 240 || routeFor(candidate) !== candidate.route) throw error('提交类型或标识无效。', 'QUEUE_INVALID_PAYLOAD')
  if (currentOwner.role !== 'patient' && !doctorQueueKind(candidate.kind)) throw error('医生账号只能重试本人已确认的消息或关注处理。', 'SESSION_CHANGED')
  const payload = copy(candidate.payload)
  if (candidate.kind !== 'service_coverage' && !positive(payload.patient_id)) throw error('提交缺少固定档案，请重新读取任务。', 'QUEUE_INVALID_PAYLOAD')
  if (candidate.kind === 'service_coverage') {
    const original = originalCoverageContext({ payload })
    if (payload.client_coverage_id !== candidate.id || !positive(payload.doctor_user_id) || !original ||
      original.actor_user_id !== currentOwner.user_id || !digest(candidate.expected_context_digest) ||
      !Number.isInteger(payload.expected_previous_version) || payload.expected_previous_version < 0 ||
      payload.timezone !== 'Asia/Shanghai' || !Array.isArray(payload.working_periods) || !payload.working_periods.length ||
      !positive(payload.expected_response_working_minutes) || typeof payload.approved_process_reference !== 'string' || !payload.approved_process_reference.trim() ||
      typeof payload.escalation_instructions !== 'string' || !payload.escalation_instructions.trim() || payload.patient_id !== undefined) throw error('覆盖配置缺少实际机构、医生、原版本或原审核凭据。', 'QUEUE_INVALID_PAYLOAD')
  }
  if (candidate.kind === 'assessment' && (payload.submission_id !== candidate.id || payload.actor_user_id !== currentOwner.user_id || payload.submitter_user_id !== currentOwner.user_id)) throw error('提交身份或标识与当前账号不一致。', 'QUEUE_INVALID_PAYLOAD')
  if (candidate.kind === 'cycle_daily' && (payload.client_submission_id !== candidate.id || !positive(payload.cycle_id) ||
    typeof payload.record_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.record_date) ||
    !Number.isInteger(payload.expected_revision) || payload.expected_revision < 0)) throw error('周期记录缺少固定日期、周期或修订版本。', 'QUEUE_INVALID_PAYLOAD')
  if (candidate.kind === 'cycle_create' && (payload.client_cycle_id !== candidate.id || payload.cycle_type !== 'self' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(payload.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(payload.end_date))) throw error('周期创建缺少固定标识或日期。', 'QUEUE_INVALID_PAYLOAD')
  if (candidate.kind === 'shared_message' && (payload.client_message_id !== candidate.id || !positive(payload.relationship_id) || payload.confirmed !== true ||
    typeof payload.content !== 'string' || !payload.content.trim() || payload.content.length > 2000 || typeof payload.send_context !== 'string' ||
    !payload.send_context || !digest(candidate.expected_context_digest) || !positive(candidate.expected_relationship_revision))) throw error('共享消息缺少已确认的原内容、接收关系或原权限凭据。', 'QUEUE_INVALID_PAYLOAD')
  if (candidate.kind === 'attention_action') {
    const original = originalAttentionContext({ payload })
    if (payload.client_action_id !== candidate.id || !positive(payload.attention_id) || !positive(payload.expected_version) ||
      payload.confirmed !== true || !Object.prototype.hasOwnProperty.call(ACTION_STATUSES, payload.action) || !digest(candidate.expected_context_digest) ||
      !original || original.actor_user_id !== currentOwner.user_id ||
      (payload.reason !== null && (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.length > 2000)) ||
      (payload.action !== 'acknowledge' && !payload.reason) ||
      (payload.action === 'acknowledge' && original.previous_status !== 'open') ||
      (payload.action === 'resolve' && original.previous_status !== 'acknowledged')) throw error('关注处理缺少原事项、已确认动作、实际说明或原权限凭据。', 'QUEUE_INVALID_PAYLOAD')
  }
  if (transfer.KINDS.includes(candidate.kind) && !transfer.valid({ ...candidate, payload }, currentOwner, canonical)) throw error('交接原件缺少实际身份、对象清单、明确确认或原上下文。', 'QUEUE_INVALID_PAYLOAD')
  if (review.KINDS.includes(candidate.kind) && !review.valid({ ...candidate, payload }, currentOwner, canonical)) throw error('审核原件缺少实际医生、输入版本、明确确认或原草稿。', 'QUEUE_INVALID_PAYLOAD')
  if (candidate.kind === 'cycle_review' && !cycleReview.valid({ ...candidate, payload }, currentOwner)) throw error('阶段复核原件缺少实际身份、日期来源或明确确认。', 'QUEUE_INVALID_PAYLOAD')
  if (candidate.kind === 'imaging_report' && !imagingReport.valid({ ...candidate, payload }, currentOwner)) throw error('影像发布缺少实际医生、原分析或明确确认。', 'QUEUE_INVALID_PAYLOAD')
  if (candidate.kind === 'artifact_decision' && !artifactDecision.valid({ ...candidate, payload }, currentOwner)) throw error('草稿决定缺少实际操作者、原稿和明确确认。', 'QUEUE_INVALID_PAYLOAD')
  if (federatedConsent.KINDS.includes(candidate.kind) && !federatedConsent.valid({ ...candidate, payload }, currentOwner)) throw error('研究授权原件缺少本人具体档案、项目、范围或原版本。', 'QUEUE_INVALID_PAYLOAD')
  if (candidate.kind === 'agent_run' && !agent.valid({ ...candidate, payload }, currentOwner)) throw error('助手请求缺少实际账号、档案、原输入或问题。', 'QUEUE_INVALID_PAYLOAD')
  const fingerprint = fingerprintFor({ ...candidate, payload }), existing = store.entries.find(item => item.id === candidate.id)
  if (existing) {
    if (existing.fingerprint !== fingerprint || existing.kind !== candidate.kind || existing.route !== candidate.route) throw error('相同提交标识的内容冲突，原记录已保留。', 'QUEUE_CONFLICT')
    return copy(existing)
  }
  if (store.entries.length >= MAX_ENTRIES) throw error('本机待同步队列容量已满，请先同步已有内容。', 'QUEUE_FULL')
  if (candidate.kind === 'assessment' && store.entries.some(item => item.kind === 'assessment' &&
    (item.payload.attempt_id === payload.attempt_id || item.payload.run_id === payload.run_id))) throw error('该尝试或运行已有不可变提交，不能建立冲突内容。', 'QUEUE_CONFLICT')
  if (federatedConsent.KINDS.includes(candidate.kind) && store.entries.some(item => federatedConsent.KINDS.includes(item.kind) && item.status !== 'archived_unconfirmed' && item.payload.patient_id === payload.patient_id && federatedConsent.projectId(item) === federatedConsent.projectId(candidate))) throw error('此档案在该项目已有待确认授权操作，请先查询原编号。', 'QUEUE_CONFLICT')
  if (candidate.kind === 'artifact_decision' && store.entries.some(item => item.kind === 'artifact_decision' && item.status !== 'archived_unconfirmed' && item.payload.artifact_id === payload.artifact_id)) throw error('该草稿已有待确认的决定，请先查询原编号。', 'QUEUE_CONFLICT')
  if (candidate.kind === 'imaging_report' && store.entries.some(item => item.kind === 'imaging_report' && item.status !== 'archived_unconfirmed' && item.payload.prediction_id === payload.prediction_id)) throw error('该影像分析已有待确认的发布，请先查询原编号。', 'QUEUE_CONFLICT')
  if (candidate.kind === 'cycle_review' && store.entries.some(item => item.kind === 'cycle_review' && item.status !== 'archived_unconfirmed' && item.payload.cycle_id === payload.cycle_id)) throw error('该周期已有待确认的复核原件，请先按原编号查询。', 'QUEUE_CONFLICT')
  if (candidate.kind === 'cycle_daily' && store.entries.some(item => item.kind === 'cycle_daily' &&
    item.payload.patient_id === payload.patient_id && item.payload.cycle_id === payload.cycle_id &&
    item.payload.record_date === payload.record_date && item.payload.expected_revision === payload.expected_revision)) throw error('该周期日期已有未确认的修订，不能建立冲突内容。', 'QUEUE_CONFLICT')
  if (candidate.kind === 'attention_action' && store.entries.some(item => item.status !== 'archived_unconfirmed' && item.kind === 'attention_action' &&
    item.payload.attention_id === payload.attention_id && item.payload.expected_version === payload.expected_version)) throw error('该事项版本已有待确认处理，原记录已保留，不能建立冲突动作。', 'QUEUE_CONFLICT')
  if (candidate.kind === 'service_coverage' && store.entries.some(item => item.status !== 'archived_unconfirmed' && item.kind === 'service_coverage' && item.payload.institution_id === payload.institution_id &&
    item.payload.doctor_user_id === payload.doctor_user_id && item.payload.expected_previous_version === payload.expected_previous_version)) throw error('该机构医生版本已有待确认配置，不能建立冲突原件。', 'QUEUE_CONFLICT')
  if (transfer.KINDS.includes(candidate.kind) && store.entries.some(item => item.status !== 'archived_unconfirmed' && transfer.conflict(item, { ...candidate, payload }))) throw error('该对象已有待确认交接或处理，请先核对原件。', 'QUEUE_CONFLICT')
  if (review.KINDS.includes(candidate.kind) && store.entries.some(item => item.status !== 'archived_unconfirmed' && review.KINDS.includes(item.kind) &&
    item.payload.assessment_id === payload.assessment_id)) throw error('本轮已有待确认审核或发布，请先核对原件。', 'QUEUE_CONFLICT')
  const item = { id: candidate.id, kind: candidate.kind, route: candidate.route, payload, fingerprint,
    session_revision: capturePatientSessionLease().revision, status: 'pending_sync', created_at: new Date().toISOString() }
  if (candidate.kind === 'shared_message') Object.assign(item, { expected_context_digest: candidate.expected_context_digest,
    expected_relationship_revision: candidate.expected_relationship_revision })
  if (['attention_action', 'service_coverage', ...transfer.KINDS].includes(candidate.kind)) item.expected_context_digest = candidate.expected_context_digest
  if (review.KINDS.includes(candidate.kind)) {
    item.expected_context_digest = candidate.expected_context_digest
    if (candidate.kind === 'review_publication') item.expected_review = copy(candidate.expected_review)
  }
  if (['agent_run', 'cycle_review', 'artifact_decision', 'imaging_report'].includes(candidate.kind)) item.expected_context_digest = candidate.expected_context_digest
  store.entries.push(item); persist(store)
  return copy(item)
}
function allEntries() {
  const currentOwner = owner(), stored = readStore()
  return !stored || !sameOwner(stored.owner, currentOwner) ? [] : copy(stored.entries)
}
function pendingEntries() { return allEntries().filter(item => item.status !== 'archived_unconfirmed') }
const rejectionStatus = code => code === 403 ? 'authorization_blocked' : [409, 422].includes(code) ? 'conflict_blocked' : null
const archivableKind = kind => ['attention_action', 'service_coverage', 'agent_run', 'cycle_review', 'artifact_decision', 'imaging_report', ...federatedConsent.KINDS, ...transfer.KINDS, ...review.KINDS].includes(kind)
function canArchive(item) {
  return !!item && archivableKind(item.kind) && item.status !== 'archived_unconfirmed' &&
    item.status === rejectionStatus(item.write_rejection_status) && item.original_query_status === 404
}
function archiveQueued(id, confirmation = {}) {
  const currentOwner = owner(), lease = capturePatientSessionLease(), store = ownedStore(currentOwner)
  const item = store.entries.find(row => row.id === id)
  if (confirmation.confirmed !== true || !canArchive(item) || inFlight.has(`${canonical(currentOwner)}:${id}`) || !current(lease, currentOwner)) return false
  // Retain the immutable body, context, fingerprint and rejection. This local
  // status is never a server cancellation and never permits posting this ID.
  return updateEntry(item, currentOwner, { status: 'archived_unconfirmed', locally_archived_at: new Date().toISOString() })
}
function current(lease, expectedOwner) {
  if (!isPatientSessionLeaseCurrent(lease)) return false
  try { return sameOwner(owner(), expectedOwner) } catch (_) { return false }
}
const canonicalType = value => ({ gonogo: 'reaction', go_no_go: 'reaction', 'simple-reaction': 'simple_reaction', digit_span: 'digit', 'digit-span': 'digit' }[value] || value)
const DAILY_FIELDS = ['mood_tag', 'focus_minutes', 'note', 'test_score', 'activities', 'is_medication', 'medication_dosage',
  'attention_rating', 'hyperactivity_rating', 'impulsivity_rating', 'emotion_rating', 'task_completion_rating', 'sleep_quality',
  'appetite_quality', 'has_conflict', 'was_criticized', 'side_effects', 'special_events', 'highlights']
function normalizedDailyContent(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !DAILY_FIELDS.includes(key))) return null
  const result = {}
  for (const key of DAILY_FIELDS) result[key] = value[key] === undefined ? null : value[key]
  if (result.activities !== null) {
    const tags = typeof result.activities === 'string' ? result.activities.split(',') : result.activities
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) return null
    result.activities = [...new Set(tags.map(tag => tag.trim()).filter(Boolean))]
    if (!result.activities.length) result.activities = null
  }
  return result
}
function normalizedInstant(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return false
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)
  return `${Math.floor(milliseconds / 1000)}:${(((fraction && fraction[1]) || '') + '000000').slice(0, 6)}`
}
function matchesAck(item, ack, originalOwner) {
  if (!ack) return false
  if (federatedConsent.KINDS.includes(item.kind)) return federatedConsent.matches(item, ack, originalOwner, canonical)
  if (item.kind === 'cycle_review') return cycleReview.matches(item, ack, originalOwner, canonical)
  if (item.kind === 'imaging_report') return imagingReport.matches(item, ack, originalOwner, canonical)
  if (item.kind === 'artifact_decision') return artifactDecision.matches(item, ack, originalOwner, canonical)
  if (item.kind === 'agent_run') return agent.matches(item, ack, originalOwner, canonical)
  if (review.KINDS.includes(item.kind)) return review.matches(item, ack, originalOwner, canonical)
  if (transfer.KINDS.includes(item.kind)) return transfer.matches(item, ack, originalOwner, canonical)
  const payload = item.payload
  if (item.kind === 'service_coverage') {
    const original = originalCoverageContext(item)
    return original !== null && original.actor_user_id === originalOwner.user_id && positive(ack.id) &&
      ack.reviewer_user_id === original.actor_user_id && ack.version === payload.expected_previous_version + 1 &&
      ack.configuration_context_digest === item.expected_context_digest && digest(ack.payload_digest) &&
      ack.submission_status === 'committed' && ack.legacy === false &&
      typeof ack.effective_from === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(ack.effective_from) && Number.isFinite(Date.parse(ack.effective_from)) &&
      ['client_coverage_id', 'doctor_user_id', 'institution_id', ...COVERAGE_FIELDS].every(key => canonical(ack[key]) === canonical(payload[key]))
  }
  if (item.kind === 'attention_action') {
    const original = originalAttentionContext(item)
    return original !== null && original.actor_user_id === originalOwner.user_id &&
      ack.actor_user_id === original.actor_user_id && ack.actor_identity_basis === original.actor_identity_basis &&
      positive(ack.action_id) && ack.submission_status === 'committed' && ack.legacy === false && ack.confirmed === true &&
      ack.action_context_digest === item.expected_context_digest && ack.previous_status === original.previous_status &&
      ack.status === ACTION_STATUSES[payload.action] && ack.version === payload.expected_version + 1 &&
      Array.isArray(ack.authorization_snapshot) && canonical(ack.authorization_snapshot) === canonical(original.authorization_snapshot) &&
      typeof ack.occurred_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(ack.occurred_at) && Number.isFinite(Date.parse(ack.occurred_at)) &&
      ['client_action_id', 'attention_id', 'patient_id', 'expected_version', 'action', 'reason'].every(key => ack[key] === payload[key])
  }
  if (item.kind === 'shared_message') {
    const parties = originalSharedParties(item)
    return parties !== null && parties.sender_user_id === originalOwner.user_id &&
    ack.doctor_user_id === parties.doctor_user_id && ack.patient_actor_user_id === parties.patient_actor_user_id &&
    ack.sender_identity_basis === parties.sender_identity_basis &&
    Array.isArray(ack.scope) && canonical(ack.scope) === '["care"]' &&
    Array.isArray(parties.authorization_snapshot) && Array.isArray(ack.authorization_snapshot) &&
    canonical(ack.authorization_snapshot) === canonical(parties.authorization_snapshot) &&
    typeof ack.sent_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(ack.sent_at) && Number.isFinite(Date.parse(ack.sent_at)) &&
    ack.submission_status === 'committed' && ack.legacy === false && positive(ack.message_id) &&
    ack.sender_user_id === originalOwner.user_id && ack.sender_kind === (originalOwner.role === 'researcher' ? 'doctor' : 'patient') &&
    ack.version === 1 && ack.confirmed === true && ack.relationship_revision === item.expected_relationship_revision &&
    ack.send_context_digest === item.expected_context_digest && digest(ack.content_digest) && digest(ack.context_digest) &&
    (ack.source_ai_decision_id == null ? null : ack.source_ai_decision_id) === (payload.source_ai_decision_id == null ? null : payload.source_ai_decision_id) &&
    ['client_message_id', 'patient_id', 'relationship_id', 'content', 'reply_to_message_id'].every(key => ack[key] === payload[key])
  }
  if (item.kind === 'cycle_create') return positive(ack.id) && ack.cycle_type === 'self' &&
    ack.actor_user_id === originalOwner.user_id && ack.calendar_timezone === 'Asia/Shanghai' &&
    ack.responsible_doctor_id === null && ack.plan_version_id === null &&
    ['client_cycle_id', 'patient_id', 'start_date', 'end_date'].every(key => ack[key] === payload[key])
  if (item.kind === 'cycle_daily') {
    const expected = normalizedDailyContent(payload.content), actual = normalizedDailyContent(ack.content)
    const expectedTime = normalizedInstant(payload.recorded_at), actualTime = normalizedInstant(ack.recorded_at)
    return ack.submission_status === 'committed' && ack.legacy === false && positive(ack.record_id) &&
      ack.actor_user_id === originalOwner.user_id && ack.expected_revision === payload.expected_revision &&
      Object.prototype.hasOwnProperty.call(ack, 'recorded_at') && expectedTime !== false && actualTime !== false && expectedTime === actualTime &&
      expected !== null && actual !== null && canonical(expected) === canonical(actual) &&
      typeof ack.content_digest === 'string' && /^[a-f0-9]{64}$/.test(ack.content_digest) &&
      ['client_submission_id', 'patient_id', 'cycle_id', 'record_date'].every(key => ack[key] === payload[key]) && ack.revision === payload.expected_revision + 1
  }
  if (!positive(ack.id || (ack.result && ack.result.id))) return false
  if (item.kind === 'assessment') return ack.submission_status === 'committed' && ack.execution_status === 'submitted' && ack.result &&
    positive(ack.result.id) && ack.result.kind === payload.kind && ack.result.legacy === false && typeof ack.canonical_digest === 'string' && /^[a-f0-9]{64}$/.test(ack.canonical_digest) &&
    ['submission_id', 'patient_id', 'assessment_id', 'assessment_item_id', 'attempt_id', 'run_id', 'task_id'].every(key => ack[key] === payload[key])
  if (item.kind === 'legacy_cognitive') return canonicalType(ack.test_type) === canonicalType(payload.test_type) &&
    ack.result_json && ack.result_json.test_run_id === payload.result_json.test_run_id
  return false
}
function updateEntry(item, currentOwner, changes) {
  const store = ownedStore(currentOwner), index = store.entries.findIndex(row => row.id === item.id && row.fingerprint === item.fingerprint)
  if (index < 0) return false
  if (changes === null) store.entries.splice(index, 1)
  else Object.assign(store.entries[index], changes)
  persist(store); return true
}
async function synchronize(id, queryOnly, returnAck = false) {
  let lease, currentOwner, item, lock, acquired = false
  try {
    currentOwner = owner(); lease = capturePatientSessionLease()
    item = ownedStore(currentOwner).entries.find(row => row.id === id)
    if (!item || (queryOnly && !['assessment', 'cycle_daily', 'shared_message', 'attention_action', 'service_coverage', 'agent_run', 'cycle_review', 'artifact_decision', 'imaging_report', ...federatedConsent.KINDS, ...transfer.KINDS, ...review.KINDS].includes(item.kind))) return false
    if (!queryOnly && item.status === 'archived_unconfirmed') return false
    lock = `${canonical(currentOwner)}:${id}`
    if (inFlight.has(lock)) return false
    inFlight.add(lock)
    acquired = true
    if (!current(lease, currentOwner)) return false
    if (!queryOnly && archivableKind(item.kind)) {
      // A new manual POST can commit even if its response is lost. Invalidate
      // the previous rejection/404 pair durably before sending anything.
      if (!updateEntry(item, currentOwner, { write_rejection_status: null, original_query_status: null })) return false
      item.write_rejection_status = null; item.original_query_status = null
    }
    const queryRoute = federatedConsent.KINDS.includes(item.kind) ? '/federated/submissions/' : item.kind === 'imaging_report' ? '/care/imaging-reports/submissions/' : item.kind === 'artifact_decision' ? '/agent/artifact-decisions/submissions/' : item.kind === 'cycle_review' ? '/care/cycle-reviews/submissions/' : item.kind === 'agent_run' ? '/agent/runs/submissions/' : review.KINDS.includes(item.kind) ? review.queryRoute(item.kind) : transfer.KINDS.includes(item.kind) ? transfer.queryRoute(item.kind) : item.kind === 'service_coverage' ? '/identity/service-coverage-submissions/' : item.kind === 'attention_action' ? '/care/attention-actions/' : item.kind === 'shared_message' ? '/care/shared-messages/submissions/' : item.kind === 'cycle_daily' ? '/care/daily-records/' : '/care/submissions/'
    const ack = await request(queryOnly ? { url: queryRoute + encodeURIComponent(id) } : { url: item.route, method: 'POST', data: copy(item.payload) })
    if (!current(lease, currentOwner)) return false
    if (!matchesAck(item, ack, currentOwner)) {
      updateEntry(item, currentOwner, { status: item.status === 'archived_unconfirmed' ? item.status :
        queryOnly && archivableKind(item.kind) && rejectionStatus(item.write_rejection_status) || 'ack_unverified',
        ...(archivableKind(item.kind) ? { original_query_status: queryOnly ? 200 : null } : {}) }); return false
    }
    return updateEntry(item, currentOwner, null) ? returnAck ? ack : true : false
  } catch (failure) {
    if (item && current(lease, currentOwner)) {
      let status = rejectionStatus(failure.statusCode) || 'pending_sync'
      const changes = {}
      if (archivableKind(item.kind)) {
        if (queryOnly) {
          status = item.status === 'archived_unconfirmed' ? item.status : rejectionStatus(item.write_rejection_status) || status
          changes.original_query_status = failure.statusCode || null
        } else {
          changes.write_rejection_status = rejectionStatus(failure.statusCode) ? failure.statusCode : null
          changes.original_query_status = null
        }
      }
      try { updateEntry(item, currentOwner, { ...changes, status }) } catch (_) {}
    }
    return false
  } finally { if (acquired) inFlight.delete(lock) }
}
async function retryPending(filter = () => true, canContinue = () => true) {
  const currentOwner = owner(), lease = capturePatientSessionLease()
  const items = pendingEntries().filter(item => !['authorization_blocked', 'conflict_blocked'].includes(item.status) && filter(item))
  let acknowledged = 0
  for (const item of items) {
    if (!current(lease, currentOwner) || !canContinue()) break
    if (await synchronize(item.id, false)) acknowledged++
    else if (current(lease, currentOwner) && pendingEntries().some(row => row.id === item.id && row.status === 'authorization_blocked')) break
  }
  return acknowledged
}
module.exports = { QUEUE_KEY, MAX_ENTRIES, MAX_BYTES, enqueue, pendingEntries, allEntries, canArchive, archiveQueued, syncQueued: id => synchronize(id, false),
  syncQueuedAcknowledgement: id => synchronize(id, false, true),
  queryQueuedAcknowledgement: id => synchronize(id, true, true),
  queryQueuedStatus: id => synchronize(id, true), retryPending }
