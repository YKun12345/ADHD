const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

const digest = '5'.repeat(64)
function original(id, attentionId) {
  const snapshot = [['independent-original-authority']]
  const context = { purpose: 'attention_action', version: 1, actor_user_id: 7,
    actor_identity_basis: 'independent-actual-self', patient_id: 8, attention_id: attentionId,
    expected_version: 1, previous_status: 'open', authorization_snapshot: snapshot }
  const payload = { client_action_id: id, patient_id: 8, attention_id: attentionId, expected_version: 1,
    action: 'acknowledge', reason: null, confirmed: true,
    action_context: `attention-action-context.v1.${Buffer.from(JSON.stringify(context)).toString('base64url')}.${'a'.repeat(64)}` }
  return { entry: { id, kind: 'attention_action', route: '/care/attention-actions', payload, expected_context_digest: digest },
    ack: { ...payload, action_id: attentionId + 100, actor_user_id: 7, actor_identity_basis: context.actor_identity_basis,
      previous_status: 'open', status: 'acknowledged', version: 2, occurred_at: '2026-10-16T10:00:00+00:00',
      action_context_digest: digest, authorization_snapshot: snapshot, submission_status: 'committed', legacy: false } }
}
const denied = statusCode => Object.assign(new Error('independent controlled transport'), { statusCode })

test('independent exact GET ACK clears only its own original and same-account token rotation withholds the old late ACK', async () => {
  const h = createHarness()
  try {
    const queue = require('../utils/submission-queue')
    const first = original('quality-first-original', 11), second = original('quality-second-original', 12)
    queue.enqueue(first.entry); queue.enqueue(second.entry)
    const before = queue.allEntries()
    let release
    h.setRequest(options => {
      assert.equal(options.method || 'GET', 'GET')
      if (options.url.endsWith(first.entry.id)) return new Promise(resolve => { release = () => resolve(first.ack) })
      return Promise.resolve(second.ack)
    })
    const pending = queue.queryQueuedStatus(first.entry.id)
    await h.flush()
    assert.equal(await queue.queryQueuedStatus(second.entry.id), true)
    assert.deepEqual(queue.allEntries().map(row => row.id), [first.entry.id])
    h.storage.access_token = 'independent-new-token-same-account'
    release()
    assert.equal(await pending, false)
    assert.deepEqual(queue.allEntries()[0].payload, before[0].payload)
    assert.equal(queue.allEntries()[0].fingerprint, before[0].fingerprint)
    h.setRequest(async options => { assert.equal(options.method || 'GET', 'GET'); return first.ack })
    assert.equal(await queue.queryQueuedStatus(first.entry.id), true)
    assert.deepEqual(queue.allEntries(), [])
  } finally { h.restore() }
})

test('independent in-flight manual repost durably clears old refusal before network and an unknown outcome cannot archive using that refusal', async () => {
  const h = createHarness()
  try {
    const queue = require('../utils/submission-queue'), fixed = original('quality-unknown-after-old-rejection', 21)
    queue.enqueue(fixed.entry)
    h.setRequest(async () => { throw denied(409) }); await queue.syncQueued(fixed.entry.id)
    h.setRequest(async () => { throw denied(404) }); await queue.queryQueuedStatus(fixed.entry.id)
    assert.equal(queue.canArchive(queue.allEntries()[0]), true)
    let reject
    h.setRequest(options => {
      assert.equal(options.method, 'POST')
      const persisted = queue.allEntries()[0]
      assert.equal(persisted.write_rejection_status, null)
      assert.equal(persisted.original_query_status, null)
      assert.equal(queue.canArchive(persisted), false)
      return new Promise((_, fail) => { reject = () => fail(new Error('independent response lost after possible commit')) })
    })
    const pending = queue.syncQueued(fixed.entry.id); await h.flush()
    assert.equal(queue.archiveQueued(fixed.entry.id, { confirmed: true }), false)
    reject(); assert.equal(await pending, false)
    h.setRequest(async () => { throw denied(404) }); await queue.queryQueuedStatus(fixed.entry.id)
    assert.equal(queue.canArchive(queue.allEntries()[0]), false)
    assert.equal(queue.archiveQueued(fixed.entry.id, { confirmed: true }), false)
    assert.deepEqual(queue.allEntries()[0].payload, fixed.entry.payload)
  } finally { h.restore() }
})
