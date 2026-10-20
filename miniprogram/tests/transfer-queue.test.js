const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const digest = 'd'.repeat(64)
const source = { source_type: 'attention', source_id: 12, expected_version: 1 }
const fullSource = { ...source, from_doctor_user_id: 80, claim_revision: 0, claimed_transfer_id: null }
function fixture(kind, id = 'fixed-original') {
  const context = { purpose: `care_transfer_${kind === 'transfer_request' ? 'request' : kind === 'transfer_decision' ? 'decision' : 'work'}`,
    context_version: 1, actor_user_id: 7, actor_identity_basis: 'synthetic-actual-basis', patient_id: 19,
    authorization_snapshot: [['synthetic-original-receipt']] }
  let payload, ack
  if (kind === 'transfer_request') {
    Object.assign(context, { receiving_relationship_id: 20, receiving_relationship_revision: 2, receiver_doctor_user_id: 90,
      selected: [source], sources: [fullSource], reason: null })
    payload = { client_transfer_id: id, patient_id: 19, receiving_relationship_id: 20, sources: [source], reason: null, confirmed: true }
    ack = { id: 31, ...payload, author_user_id: 7, author_identity_basis: context.actor_identity_basis, receiver_doctor_user_id: 90,
      sources: [fullSource], request_context_digest: digest, version: 1, status: 'pending_acceptance', status_snapshot_at_creation: true,
      requested_at: '2026-10-16T04:00:00+00:00' }
  } else if (kind === 'transfer_decision') {
    Object.assign(context, { transfer_id: 31, expected_version: 1, allowed_decisions: ['accept', 'reject'], source_count: 1 })
    payload = { client_decision_id: id, patient_id: 19, transfer_id: 31, expected_version: 1, decision: 'accept', reason: null, confirmed: true }
    ack = { id: 41, ...payload, actor_user_id: 7, actor_identity_basis: context.actor_identity_basis, decision_context_digest: digest,
      version: 2, status: 'accepted', work_item_ids: [51], decided_at: '2026-10-16T04:00:00+00:00' }
  } else {
    Object.assign(context, { work_item_id: 51, expected_version: 1, previous_status: 'open' })
    payload = { client_action_id: id, patient_id: 19, work_item_id: 51, expected_version: 1, action: 'acknowledge', reason: null, confirmed: true }
    ack = { action_id: 61, ...payload, actor_user_id: 7, actor_identity_basis: context.actor_identity_basis, action_context_digest: digest,
      version: 2, previous_status: 'open', status: 'acknowledged', occurred_at: '2026-10-16T04:00:00+00:00' }
  }
  const field = kind === 'transfer_request' ? 'request_context' : kind === 'transfer_decision' ? 'decision_context' : 'action_context'
  const prefix = kind === 'transfer_request' ? 'request' : kind === 'transfer_decision' ? 'decision' : 'work'
  payload[field] = `care-transfer-${prefix}-context.v1.${Buffer.from(JSON.stringify(context)).toString('base64url')}.${'a'.repeat(64)}`
  Object.assign(ack, { authorization_snapshot: context.authorization_snapshot, payload_digest: 'e'.repeat(64), submission_status: 'committed', legacy: false })
  const route = kind === 'transfer_request' ? '/care/responsibility-transfers' : kind === 'transfer_decision' ? '/care/responsibility-transfer-decisions' : '/care/transferred-work-actions'
  return { entry: { id, kind, route, expected_context_digest: digest, payload }, ack, context }
}

for (const kind of ['transfer_request', 'transfer_decision', 'transfer_work_action']) test(`${kind} persists the fixed original and verifies the actual ACK and original-ID recovery`, async () => {
  const h = createHarness()
  try {
    if (kind !== 'transfer_request') h.storage.current_user.role = 'researcher'
    const q = require('../utils/submission-queue'), { entry, ack } = fixture(kind)
    q.enqueue(entry)
    assert.equal(require('../utils/session-privacy').summarizePatientData().pendingCount, 1)
    for (const changed of [{ authorization_snapshot: [] }, { version: 99 }, { patient_id: 88 }, { legacy: true }, { submission_status: 'pending' },
      kind === 'transfer_request' ? { receiver_doctor_user_id: 91 } : { actor_user_id: 9 },
      kind === 'transfer_request' ? { sources: [] } : kind === 'transfer_decision' ? { work_item_ids: [] } : { previous_status: 'acknowledged' }]) {
      h.setRequest(async () => ({ ...ack, ...changed }))
      assert.equal(await q.syncQueued(entry.id), false)
      assert.deepEqual(q.pendingEntries()[0].payload, entry.payload)
    }
    h.setRequest(async options => {
      assert.equal(options.method, undefined)
      assert.equal(options.url, entry.route + (kind === 'transfer_request' ? '/submissions/' : '/') + entry.id)
      return ack
    })
    assert.equal(await q.queryQueuedStatus(entry.id), true)
    assert.deepEqual(q.pendingEntries(), [])
  } finally { h.restore() }
})

test('a doctor cannot create a patient authorization original and a late ACK cannot clear another account', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'), first = fixture('transfer_request')
    h.storage.current_user.role = 'researcher'
    assert.throws(() => q.enqueue(first.entry))
    const { entry, ack } = fixture('transfer_decision'); q.enqueue(entry)
    let finish
    h.setRequest(() => new Promise(resolve => { finish = () => resolve(ack) }))
    const pending = q.syncQueued(entry.id); await Promise.resolve()
    require('../utils/session-privacy').replacePatientSession({ access_token: 'actual-other', user: { id: 9, role: 'researcher' } })
    finish(); assert.equal(await pending, false)
    assert.equal(h.storage.current_user.id, 9)
  } finally { h.restore() }
})

module.exports = { fixture }
