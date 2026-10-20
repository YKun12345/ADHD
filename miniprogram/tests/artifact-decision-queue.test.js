const { test } = require('node:test'), assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
test('human artifact decision cannot be acknowledged as another draft, body, version or target', async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    const hash = 'a'.repeat(64), ctx = { purpose: 'artifact_decision', context_version: 1, actor_user_id: 7,
      actor_identity_basis: 'actual-doctor-basis', patient_id: 8, artifact_id: 12, input_digest: hash, artifact_body_digest: hash,
      artifact_source_digest: hash, expected_previous_version: 0, authorization_snapshot: [['actual-draft-authority']] }
    const token = `artifact-decision-context.v1.${Buffer.from(JSON.stringify(ctx)).toString('base64url')}.${hash}`
    const content = { source_type: 'submission', source_key: 'actual-original', question: '本人修改的问题' }
    const item = { id: 'human-edited', kind: 'artifact_decision', route: '/agent/artifact-decisions', expected_context_digest: hash,
      payload: { client_decision_id: 'human-edited', artifact_id: 12, patient_id: 8, expected_previous_version: 0,
        decision_context: token, decision: 'edit', content, reason: '已核对实际原件', confirmed: true } }
    const ack = { id: 30, client_decision_id: item.id, patient_id: 8, artifact_id: 12, actor_user_id: 7,
      actor_identity_basis: ctx.actor_identity_basis, version: 1, input_digest: hash, decision: 'edit', content,
      target_type: 'review_question', target_client_id: 'ai-use-' + 'b'.repeat(40), payload_digest: hash,
      decision_context_digest: hash, original_request: item.payload, authorization_snapshot: ctx.authorization_snapshot,
      submission_status: 'committed', legacy: false, confirmed: true, created_at: '2026-10-16T16:00:00+00:00' }
    const q = require('../utils/submission-queue'); q.enqueue(item)
    for (const change of [{ actor_user_id: 8 }, { artifact_id: 13 }, { version: 2 }, { content: { ...content, question: '另一个问题' } },
      { original_request: { ...item.payload, decision: 'adopt' } }, { target_type: 'publish_diagnosis' }, { authorization_snapshot: [] }]) {
      h.setRequest(async () => ({ ...ack, ...change })); assert.equal(await q.syncQueued(item.id), false)
      assert.deepEqual(q.pendingEntries()[0].payload, item.payload)
    }
    h.setRequest(async options => { assert.equal(options.url, '/agent/artifact-decisions/submissions/human-edited'); assert.equal(options.method || 'GET', 'GET'); return ack })
    assert.deepEqual(await q.queryQueuedAcknowledgement(item.id), ack); assert.deepEqual(q.allEntries(), [])
  } finally { h.restore() }
})
