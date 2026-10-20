const { test } = require('node:test'), assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const hash = 'a'.repeat(64)
const token = (prefix, value) => `${prefix}.v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${hash}`
for (const reply of [false, true]) test(`specific ${reply ? 'reply' : 'question'} keeps wrong ACKs and recovers only the original ID`, async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = reply ? 'patient' : 'researcher'
    const ctx = { purpose: reply ? 'clarification_reply' : 'doctor_review_context', context_version: 1,
      actor_user_id: 7, actor_identity_basis: reply ? 'guardian:7:access:1' : 'doctor:7:qualification:1', patient_id: 8, assessment_id: 2,
      assessment_version: 3, authorization_snapshot: [['actual-original-authority']],
      ...(reply ? { question_id: 12, question_payload_digest: hash, expected_previous_revision: 0 }
        : { responsible_doctor_id: 7, input_digest: hash }) }
    const original = { id: 'specific-original', kind: reply ? 'clarification_reply' : 'review_question',
      route: reply ? '/care/clarification-replies' : '/care/clarifications', expected_context_digest: hash,
      payload: { patient_id: 8, assessment_id: 2, expected_assessment_version: 3, confirmed: true,
        ...(reply ? { client_reply_id: 'specific-original', question_id: 12, expected_previous_revision: 0, answer_status: 'unknown', answer: null,
          reply_context: token('clarification-reply-context', ctx) } : { client_question_id: 'specific-original', input_digest: hash,
          review_context: token('doctor-review-context', ctx), source_type: 'submission', source_key: 'actual-original', question: '实际中断原因？' }) } }
    const ack = { id: 25, ...original.payload, actor_user_id: 7, actor_identity_basis: ctx.actor_identity_basis,
      authorization_snapshot: ctx.authorization_snapshot, payload_digest: hash, assessment_version: 4,
      status: reply ? 'answered' : 'requested', created_at: '2026-10-16T12:00:00+00:00', legacy: false, submission_status: 'committed',
      ...(reply ? { revision: 1, reply_context_digest: hash } : { review_context_digest: hash }) }
    const q = require('../utils/submission-queue'); q.enqueue(original)
    for (const change of [{ actor_user_id: 9 }, { authorization_snapshot: [] }, { assessment_version: 3 },
      reply ? { answer_status: 'provided', answer: '伪造回答' } : { question: '其他问题' }, reply ? { revision: 2 } : { source_key: 'different-original' }]) {
      h.setRequest(async () => ({ ...ack, ...change })); assert.equal(await q.syncQueued(original.id), false)
      assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
    }
    h.setRequest(async options => { assert.equal(options.method || 'GET', 'GET'); assert.equal(options.url,
      reply ? '/care/clarification-replies/submissions/specific-original' : '/care/clarifications/submissions/specific-original'); return ack })
    assert.equal(await q.queryQueuedStatus(original.id), true); assert.equal(q.allEntries().length, 0)
  } finally { h.restore() }
})
