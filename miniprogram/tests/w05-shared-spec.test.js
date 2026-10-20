// Independent synthetic counterexamples; production queue/session modules are used.
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
let store, transport, calls
const clone = value => value === undefined ? undefined : structuredClone(value)
const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true,
  exports: { request: options => { calls.push(options); return transport(options) } } }

beforeEach(() => {
  store = { current_user: { id: 71, role: 'patient' }, access_token: 'synthetic-spec-original-token' }
  global.wx = { getStorageSync: key => clone(store[key]), setStorageSync: (key, value) => { store[key] = clone(value) },
    removeStorageSync: key => { delete store[key] }, reLaunch() {}, showToast() {} }
  calls = []
  transport = async options => ack(options.data)
  delete require.cache[require.resolve('../utils/submission-queue')]
})
const queue = () => require('../utils/submission-queue')
const originalReceipts = () => [[71, 81, ['care'], 'processing', [['patient_access', 'synthetic-access-ledger', 1, 71], ['consent_records', 'synthetic-consent-ledger', 1, 18]]]]
function item(id = 'independent-spec-original') {
  const context = { purpose: 'shared_message_send', version: 1, sender_user_id: 71, patient_id: 81,
    relationship_id: 91, relationship_revision: 2, doctor_user_id: 101, patient_actor_user_id: 71,
    sender_identity_basis: 'self:71:81', authorization_snapshot: originalReceipts() }
  return { id, kind: 'shared_message', route: '/care/shared-messages', expected_context_digest: 'a'.repeat(64), expected_relationship_revision: 2,
    payload: { patient_id: 81, relationship_id: 91, client_message_id: id, content: 'Synthetic recipient-scoped original',
      confirmed: true, reply_to_message_id: null, send_context: 'shared-message-context.v1.' + Buffer.from(JSON.stringify(context)).toString('base64url') + '.' + 'b'.repeat(64) } }
}
function ack(body) {
  return { ...body, message_id: 111, sender_user_id: 71, sender_kind: 'patient', doctor_user_id: 101, patient_actor_user_id: 71,
    sender_identity_basis: 'self:71:81', scope: ['care'], authorization_snapshot: originalReceipts(), relationship_revision: 2, version: 1,
    sent_at: '2026-10-16T00:00:00+00:00', submission_status: 'committed', legacy: false,
    send_context_digest: 'a'.repeat(64), content_digest: 'c'.repeat(64), context_digest: 'd'.repeat(64) }
}

for (const change of [{ doctor_user_id: 999 }, { patient_actor_user_id: 999 }, { sender_identity_basis: 'borrowed-new-identity' },
  { sent_at: 'not-a-server-time' }, { scope: ['research'] }, { authorization_snapshot: ['not-original-receipts'] }]) {
  test('contradictory original ACK field ' + Object.keys(change)[0] + ' cannot clear an original', async () => {
    const q = queue(), original = item(); q.enqueue(original)
    transport = async options => ({ ...ack(options.data), ...change })
    assert.equal(await q.syncQueued(original.id), false)
    assert.equal(q.pendingEntries()[0].id, original.id)
    assert.equal(q.pendingEntries()[0].payload.send_context, original.payload.send_context)
  })
}

test('consistent ACK clears exactly one original after original-context decoding', async () => {
  const q = queue(); q.enqueue(item('consistent-original')); q.enqueue(item('other-retained-original'))
  assert.equal(await q.syncQueued('consistent-original'), true)
  assert.deepEqual(q.pendingEntries().map(row => row.id), ['other-retained-original'])
})

test('full queue retains every original and sends nothing on overflow', () => {
  const q = queue()
  for (let index = 0; index < q.MAX_ENTRIES; index++) q.enqueue(item('original-' + index))
  const saved = clone(store[q.QUEUE_KEY])
  assert.throws(() => q.enqueue(item('overflow-original')), failure => failure.code === 'QUEUE_FULL')
  assert.deepEqual(store[q.QUEUE_KEY], saved)
  assert.equal(calls.length, 0)
})

test('readback failure after physical write never sends and retains the same original', () => {
  const q = queue(), original = item(), read = wx.getStorageSync
  let rejectReadback = true
  wx.getStorageSync = key => key === q.QUEUE_KEY && store[key] && rejectReadback ? null : read(key)
  assert.throws(() => q.enqueue(original), failure => failure.code === 'QUEUE_STORAGE_FAILED')
  rejectReadback = false
  assert.equal(q.pendingEntries()[0].id, original.id)
  assert.equal(q.pendingEntries()[0].payload.send_context, original.payload.send_context)
  assert.equal(calls.length, 0)
})

test('old token ACK cannot clear a same-owner durable original', async () => {
  const q = queue(), original = item(); q.enqueue(original)
  let complete
  transport = options => new Promise(resolve => { complete = () => resolve(ack(options.data)) })
  const pending = q.syncQueued(original.id)
  await Promise.resolve()
  store.access_token = 'synthetic-spec-relogged-token'
  complete()
  assert.equal(await pending, false)
  assert.equal(q.pendingEntries()[0].id, original.id)
})
