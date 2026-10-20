const { test } = require('node:test'), assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
for (const role of ['patient', 'researcher']) test(`${role} queued Agent request is isolated from ordinary submissions and only its original accepted ACK removes it`, async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = role; const hash = 'a'.repeat(64)
    const ctx = { purpose: 'unified_agent_run', context_version: 1, actor_user_id: 7, role, patient_id: 8,
      input_digest: hash, authorization_snapshot: [['original-actual-authority']], credential_snapshot: [] }
    const context = `unified-agent-run-context.v1.${Buffer.from(JSON.stringify(ctx)).toString('base64url')}.${hash}`
    const original = { id: 'original-agent-request', kind: 'agent_run', route: '/agent/runs', expected_context_digest: hash,
      payload: { client_run_id: 'original-agent-request', patient_id: 8, intent: 'question', assessment_id: null, cycle_id: null,
        message: '请核对实际保存的进度', expected_context_digest: hash, run_context: context } }
    const ack = { id: 12, run_id: 12, client_run_id: original.id, actor_user_id: 7, patient_id: 8, input_digest: hash, request_digest: hash,
      run_context_digest: hash, original_request: original.payload, accepted: true, submission_status: 'committed', legacy: false,
      requested_at: '2026-10-16T12:00:00+00:00' }
    const q = require('../utils/submission-queue'); q.enqueue(original)
    for (const change of [{ actor_user_id: 9 }, { accepted: false }, { run_context_digest: 'b'.repeat(64) },
      { original_request: { ...original.payload, message: '其他问题' } }]) {
      h.setRequest(async () => ({ ...ack, ...change })); assert.equal(await q.syncQueued(original.id), false)
      assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
    }
    h.setRequest(async options => { assert.equal(options.method || 'GET', 'GET'); assert.equal(options.url, '/agent/runs/submissions/original-agent-request'); return ack })
    assert.equal(await q.queryQueuedStatus(original.id), true); assert.deepEqual(q.allEntries(), [])
  } finally { h.restore() }
})
