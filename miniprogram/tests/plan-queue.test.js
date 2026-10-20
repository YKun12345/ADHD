const { test } = require('node:test'), assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const hash = 'a'.repeat(64), stamp = '2026-10-16T12:00:00+00:00'
const token = (prefix, value) => `${prefix}.v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${hash}`
for (const receipt of [false, true]) test(`plan ${receipt ? 'receipt' : 'publication'} requires its actual original ACK and keeps mismatches`, async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = receipt ? 'patient' : 'researcher'
    const ctx = { purpose: receipt ? 'care_plan_received' : 'care_plan_publication', context_version: 1,
      actor_user_id: 7, actor_identity_basis: receipt ? 'self:7:access:1' : 'doctor:7:qualification:1',
      patient_id: 8, assessment_id: 2, authorization_snapshot: [['actual-original-plan-authority']],
      ...(receipt ? { plan_version_id: 15, plan_payload_digest: hash, version: 1, plan_revision: 1 }
        : { assessment_version: 3, expected_previous_version: 0, expected_plan_revision: 0, source_report_id: 12, input_digest: hash }) }
    const original = { id: 'plan-original', kind: receipt ? 'plan_received' : 'plan_publication',
      route: receipt ? '/care/plan-acknowledgements' : '/care/plan-versions', expected_context_digest: hash,
      payload: { patient_id: 8, assessment_id: 2, confirmed: true, ...(receipt ? { client_acknowledgement_id: 'plan-original', plan_version_id: 15,
        acknowledgement_context: token('care-plan-received-context', ctx) } : { client_plan_version_id: 'plan-original',
        expected_assessment_version: 3, expected_previous_version: 0, expected_plan_revision: 0, source_report_id: 12, input_digest: hash,
        title: '实际记录安排', instructions: '按实际情况记录', start_date: '2026-10-16', end_date: '2026-10-20', plan_context: token('care-plan-context', ctx) }) } }
    const ack = { id: receipt ? 20 : 15, ...original.payload, actor_user_id: 7, actor_identity_basis: ctx.actor_identity_basis,
      authorization_snapshot: ctx.authorization_snapshot, payload_digest: hash, version: 1, submission_status: 'committed', legacy: false,
      ...(receipt ? { acknowledgement_context_digest: hash, meaning: 'received_only', received_at: stamp }
        : { plan_id: 10, plan_revision: 1, cycle_id: 25, assessment_version: 4, plan_context_digest: hash, status: 'published', published_at: stamp, demonstration_only: true, task_type: 'daily_record' }) }
    const q = require('../utils/submission-queue'); q.enqueue(original)
    for (const change of [{ actor_user_id: 9 }, { version: 2 }, { authorization_snapshot: [] }, receipt ? { meaning: 'accepted_treatment' } : { instructions: '其他安排' }]) {
      h.setRequest(async () => ({ ...ack, ...change })); assert.equal(await q.syncQueued(original.id), false)
      assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
    }
    h.setRequest(async options => { assert.equal(options.method || 'GET', 'GET'); assert.equal(options.url,
      receipt ? '/care/plan-acknowledgements/submissions/plan-original' : '/care/plan-versions/submissions/plan-original'); return ack })
    assert.equal(await q.queryQueuedStatus(original.id), true); assert.equal(q.allEntries().length, 0)
  } finally { h.restore() }
})
