// Independent quality counterexamples: real queue/session/page, synthetic transport.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const { syntheticSendContext, readSyntheticContext } = require('./helpers/shared-message-context')
const tap = id => ({ currentTarget: { dataset: { id } } })
function entry(id = 'quality-original') {
  return { id, kind: 'shared_message', route: '/care/shared-messages', expected_context_digest: 'd'.repeat(64), expected_relationship_revision: 2,
    payload: { patient_id: 8, relationship_id: 20, client_message_id: id, content: '独立合成质量原件', confirmed: true,
      reply_to_message_id: null, send_context: syntheticSendContext({ relationship_id: 20, doctor_user_id: 90, patient_actor_user_id: 7 }) } }
}
function ack(body) {
  const original = readSyntheticContext(body.send_context)
  return { ...body, message_id: 80, sender_user_id: 7, sender_kind: 'patient', doctor_user_id: original.doctor_user_id,
    patient_actor_user_id: original.patient_actor_user_id, sender_identity_basis: original.sender_identity_basis,
    relationship_revision: 2, scope: ['care'], authorization_snapshot: original.authorization_snapshot,
    sent_at: '2026-10-16T00:00:00+00:00', version: 1, legacy: false, submission_status: 'committed',
    send_context_digest: 'd'.repeat(64), content_digest: 'a'.repeat(64), context_digest: 'b'.repeat(64) }
}

for (const statusCode of [403, 409]) {
  test('terminal ' + statusCode + ' stops automatic retries while manual recovery retains the exact original and query', async () => {
    const h = createHarness()
    try {
      const q = require('../utils/submission-queue'), original = entry(); q.enqueue(original)
      h.setRequest(async () => { throw Object.assign(new Error('synthetic terminal original'), { statusCode }) })
      const page = h.load('submission-queue')
      assert.equal(await page.retry(tap(original.id)), false)
      assert.equal(h.requests.length, 1)
      const saved = q.pendingEntries()[0]
      assert.equal(saved.status, statusCode === 403 ? 'authorization_blocked' : 'conflict_blocked')
      assert.equal(await q.retryPending(), 0)
      assert.equal(h.requests.length, 1, 'blocked originals cannot be POSTed by automatic retry')
      assert.equal(await page.retry(tap(original.id)), false)
      assert.equal(h.requests.length, 2, 'explicit manual retry is allowed only with the unchanged original')
      assert.deepEqual(h.requests.map(options => options.data), [original.payload, original.payload])
      assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
      assert.equal(q.pendingEntries()[0].status, saved.status)
      h.setRequest(async options => {
        assert.equal(options.method, undefined)
        assert.equal(options.url, '/care/shared-messages/submissions/' + original.id)
        return ack(original.payload)
      })
      assert.equal(await page.queryStatus(tap(original.id)), true)
      assert.deepEqual(q.pendingEntries(), [])
    } finally { h.restore() }
  })
}

test('failed ACK clearing preserves both immutable originals and exact query later clears only one', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'), original = entry(); q.enqueue(original); q.enqueue(entry('quality-other'))
    h.setRequest(async options => ack(options.data))
    const write = wx.setStorageSync
    wx.setStorageSync = () => { throw new Error('synthetic physical clear rejected') }
    assert.equal(await q.syncQueued(original.id), false)
    assert.deepEqual(q.pendingEntries().map(row => row.id), [original.id, 'quality-other'])
    assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
    wx.setStorageSync = write
    h.setRequest(async options => {
      assert.equal(options.method, undefined)
      assert.equal(options.url, '/care/shared-messages/submissions/' + original.id)
      return ack(original.payload)
    })
    assert.equal(await q.queryQueuedStatus(original.id), true)
    assert.deepEqual(q.pendingEntries().map(row => row.id), ['quality-other'])
  } finally { h.restore() }
})

test('legacy history distinguishes another patient-role sender from the current actual account', async () => {
  const h = createHarness()
  try {
    h.setRequest(async options => {
      assert.equal(options.url, '/care/patient/messages')
      return { legacy_scope_status: 'own_history_only', items: [
        { id: 101, sender_user_id: 71, sender_role: 'patient', content: '合成另一位旧监护人消息', sender_name: '' },
        { id: 102, sender_user_id: 7, sender_role: 'patient', content: '合成当前账号消息', sender_name: '' }
      ] }
    })
    const page = h.load('patient-messages'); await h.flush()
    assert.equal(page.data.messages.length, 2)
    assert.deepEqual({ isMine: page.data.messages[0].isMine, claimsCurrentAccount: page.data.messages[0].senderName === '我' },
      { isMine: false, claimsCurrentAccount: false })
    assert.equal(page.data.messages[1].isMine, true)
    assert.equal(h.requests.length, 1)
  } finally { h.restore() }
})
