const { test } = require('node:test'), assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const hash = 'a'.repeat(64)
for (const role of ['patient','researcher']) test(`${role} stage original requires exact ACK and keeps another cycle isolated`, async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = role
    const ctx = { purpose: 'cycle_review', context_version: 1, actor_user_id: 7, actor_identity_basis: 'actual-stage-actor-basis',
      cycle_type: role === 'patient' ? 'self' : 'professional', patient_id: 8, cycle_id: 4, expected_previous_version: 0,
      input_digest: hash, authorization_snapshot: [['actual-stage-authority']] }
    const token = value => `cycle-review-context.v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${hash}`
    const row = { id: 'stage-original', kind: 'cycle_review', route: '/care/cycle-reviews', expected_context_digest: hash,
      payload: { client_cycle_review_id: 'stage-original', patient_id: 8, cycle_id: 4, expected_previous_version: 0,
        input_digest: hash, review_context: token(ctx), decision: 'end', body: '实际阶段材料意见', limitations: '材料有局限', reason: '实际结束原因',
        followup_plan: null, next_cycle: null, confirmed: true } }
    const ack = { id: 20, client_cycle_review_id: row.id, actor_user_id: 7, actor_identity_basis: ctx.actor_identity_basis,
      patient_id: 8, cycle_id: 4, cycle_type: ctx.cycle_type, version: 1, decision: 'end', input_digest: hash, payload_digest: hash,
      review_context_digest: hash, original_request: row.payload, authorization_snapshot: ctx.authorization_snapshot,
      professional_confirmation: role === 'researcher', next_cycle_id: null, next_plan_version_id: null, next_assessment_id: null,
      created_at: '2026-10-16T16:00:00+00:00', confirmed: true, submission_status: 'committed', legacy: false }
    const q = require('../utils/submission-queue'); q.enqueue(row)
    q.enqueue({ ...row, id: 'another-stage', payload: { ...row.payload, client_cycle_review_id: 'another-stage', cycle_id: 6,
      review_context: token({ ...ctx, cycle_id: 6 }) } })
    for (const change of [{ actor_user_id: 9 }, { version: 2 }, { professional_confirmation: role !== 'researcher' },
      { original_request: { ...row.payload, body: '另一个决定' } }, { authorization_snapshot: [] }]) {
      h.setRequest(async () => ({ ...ack, ...change })); assert.equal(await q.syncQueued(row.id), false)
      assert.equal(q.pendingEntries().length, 2); assert.deepEqual(q.pendingEntries()[0].payload, row.payload)
    }
    h.setRequest(async options => { assert.equal(options.method || 'GET', 'GET'); assert.equal(options.url, '/care/cycle-reviews/submissions/stage-original'); return ack })
    assert.equal(await q.queryQueuedStatus(row.id), true)
    assert.deepEqual(q.pendingEntries().map(item => item.id), ['another-stage'])
  } finally { h.restore() }
})
