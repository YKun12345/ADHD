const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const digest = 'd'.repeat(64), payloadDigest = 'e'.repeat(64), stamp = '2026-10-16T12:00:00+00:00'
const decision = { submission_id: 'actual-original', assessment_item_id: 3, attempt_id: 4, decision: 'needs_repeat', reason: '实际执行中断' }
const token = (prefix, value) => `${prefix}.v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${'a'.repeat(64)}`
function entry(publication = false, id = 'original') {
  const ctx = { purpose: publication ? 'review_publication' : 'doctor_review_context', context_version: 1,
    actor_user_id: 7, actor_identity_basis: 'doctor:7:qualification:1:revision:1:relationship:2:revision:1',
    patient_id: 8, assessment_id: 2, input_digest: digest, authorization_snapshot: [['original-doctor-clinical-scope']],
    ...(publication ? { review_id: 12, review_payload_digest: payloadDigest, expected_assessment_version: 3, expected_previous_report_version: 0 }
      : { assessment_version: 3, responsible_doctor_id: 7, relationship_id: 2 }) }
  const expectedReview = { id: 12, payload_digest: payloadDigest, category: 'evidence_review', body: '实际医生正文', limitations: '材料不齐', decisions: [decision] }
  return { id, kind: publication ? 'review_publication' : 'review_draft', route: publication ? '/care/review-publications' : '/care/reviews',
    expected_context_digest: digest, ...(publication ? { expected_review: expectedReview } : {}),
    payload: { patient_id: 8, assessment_id: 2, expected_assessment_version: 3, input_digest: digest, confirmed: true,
      ...(publication ? { client_publication_id: id, review_id: 12, expected_previous_report_version: 0,
        publication_context: token('review-publication-context', ctx) } : {
        client_review_id: id, review_context: token('doctor-review-context', ctx), category: 'evidence_review',
        body: expectedReview.body, limitations: expectedReview.limitations, decisions: [decision] }) } }
}
function ack(original) {
  const publication = original.kind === 'review_publication'
  return { id: publication ? 21 : 12, patient_id: 8, assessment_id: 2, actor_user_id: 7,
    actor_identity_basis: 'doctor:7:qualification:1:revision:1:relationship:2:revision:1',
    category: 'evidence_review', body: '实际医生正文', limitations: '材料不齐', decisions: [decision],
    input_digest: digest, expected_assessment_version: 3, authorization_snapshot: [['original-doctor-clinical-scope']],
    payload_digest: payloadDigest, confirmed: true, demonstration_only: true, legacy: false, submission_status: 'committed',
    ...(publication ? { client_publication_id: original.id, review_id: 12, review_payload_digest: payloadDigest, version: 1,
      status: 'published', expected_previous_report_version: 0, assessment_version: 4,
      publication_context_digest: digest, published_at: stamp } : { client_review_id: original.id,
      status: 'draft', review_context_digest: digest, created_at: stamp }) }
}
for (const publication of [false, true]) {
  test(`${publication ? 'publication' : 'draft'} is durable and only its complete original ACK removes it`, async () => {
    const h = createHarness()
    try {
      h.storage.current_user.role = 'researcher'
      const q = require('../utils/submission-queue'), original = entry(publication)
      q.enqueue(original)
      for (const variation of [{ actor_user_id: 9 }, { actor_identity_basis: 'different-basis' }, { input_digest: 'f'.repeat(64) },
        { body: '不同正文' }, { limitations: '不同局限' }, { decisions: [] }, { authorization_snapshot: [] },
        { expected_assessment_version: 4 }, { status: publication ? 'draft' : 'published' }, { confirmed: false },
        { [publication ? 'publication_context_digest' : 'review_context_digest']: 'f'.repeat(64) }]) {
        h.setRequest(async () => ({ ...ack(original), ...variation }))
        assert.equal(await q.syncQueued(original.id), false, JSON.stringify(variation))
        assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
      }
      h.setRequest(async options => {
        assert.equal(options.url, publication ? '/care/review-publications/submissions/original' : '/care/reviews/submissions/original')
        return ack(original)
      })
      assert.equal(await q.queryQueuedStatus(original.id), true)
      assert.deepEqual(q.allEntries(), [])
    } finally { h.restore() }
  })
  test(`${publication ? 'publication' : 'draft'} keeps a known rejection, archives explicitly and never reposts the archived original`, async () => {
    const h = createHarness()
    try {
      h.storage.current_user.role = 'researcher'; const q = require('../utils/submission-queue'), original = entry(publication)
      q.enqueue(original)
      h.setRequest(async () => { throw Object.assign(new Error('actual version conflict'), { statusCode: 409 }) }); await q.syncQueued(original.id)
      h.setRequest(async () => { throw Object.assign(new Error('original not found'), { statusCode: 404 }) }); await q.queryQueuedStatus(original.id)
      assert.equal(q.pendingEntries()[0].status, 'conflict_blocked')
      assert.equal(q.archiveQueued(original.id, { confirmed: true }), true)
      assert.deepEqual(q.allEntries()[0].payload, original.payload)
      assert.equal(require('../utils/session-privacy').summarizePatientData().pendingCount, 1)
      let posts = 0; h.setRequest(async options => { if (options.method === 'POST') posts++; return ack(original) })
      assert.equal(await q.syncQueued(original.id), false); assert.equal(posts, 0)
      assert.equal(await q.queryQueuedStatus(original.id), true)
      assert.equal(q.allEntries().length, 0)
    } finally { h.restore() }
  })
}
module.exports = { entry, ack }
