const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { syntheticSendContext, readSyntheticContext } = require('./helpers/shared-message-context')
let storage, send, calls
const clone = value => value === undefined ? undefined : structuredClone(value)
const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true,
  exports: { request: options => { calls.push(options); return send(options) } } }
beforeEach(() => {
  storage = { access_token: 'synthetic-shared-A', current_user: { id: 7, role: 'patient', patient_profile: { id: 8 } } }
  global.wx = { getStorageSync: key => clone(storage[key]), setStorageSync: (key, value) => { storage[key] = clone(value) },
    removeStorageSync: key => { delete storage[key] }, showToast() {}, reLaunch() {} }
  calls = []; send = async options => ack(options.data)
  delete require.cache[require.resolve('../utils/submission-queue')]
})
const queue = () => require('../utils/submission-queue')
const entry = (id, rel = 20) => ({ id, kind: 'shared_message', route: '/care/shared-messages',
  expected_context_digest: 'd'.repeat(64), expected_relationship_revision: 2,
  payload: { patient_id: 8, relationship_id: rel, client_message_id: id, content: '合成已确认消息原件',
    confirmed: true, reply_to_message_id: null, send_context: syntheticSendContext({ relationship_id: rel,
      doctor_user_id: storage.current_user.role === 'researcher' ? 7 : 90, patient_actor_user_id: storage.current_user.role === 'researcher' ? 42 : 7 }) } })
const ack = body => ({ message_id: 50, ...body, sender_user_id: 7,
  doctor_user_id: readSyntheticContext(body.send_context).doctor_user_id, patient_actor_user_id: readSyntheticContext(body.send_context).patient_actor_user_id,
  sender_identity_basis: readSyntheticContext(body.send_context).sender_identity_basis,
  scope: ['care'], authorization_snapshot: readSyntheticContext(body.send_context).authorization_snapshot, sent_at: '2026-10-16T00:00:00+00:00',
  sender_kind: storage.current_user.role === 'researcher' ? 'doctor' : 'patient', relationship_revision: 2, version: 1,
  send_context_digest: 'd'.repeat(64), content_digest: 'c'.repeat(64), context_digest: 'b'.repeat(64),
  submission_status: 'committed', legacy: false })

test('two original recipient scopes survive offline reload and exact query clears only its confirmed message', async () => {
  const q = queue(); q.enqueue(entry('message-a')); q.enqueue(entry('message-b', 21))
  send = async () => { throw new Error('synthetic offline') }
  assert.equal(await q.syncQueued('message-a'), false)
  delete require.cache[require.resolve('../utils/submission-queue')]
  const reopened = queue(); send = async options => { assert.equal(options.url, '/care/shared-messages/submissions/message-b'); return ack(entry('message-b', 21).payload) }
  assert.equal(await reopened.queryQueuedStatus('message-b'), true)
  assert.deepEqual(reopened.pendingEntries().map(row => row.id), ['message-a'])
  assert.equal(reopened.pendingEntries()[0].payload.send_context, entry('message-a').payload.send_context)
})

test('another actor, original authority or relationship revision ACK cannot delete a confirmed shared original', async () => {
  for (const change of [{ sender_user_id: 99 }, { send_context_digest: 'e'.repeat(64) }, { relationship_revision: 9 }, { content: 'different' }]) {
    const q = queue(), id = 'message-'+Object.keys(change)[0]; q.enqueue(entry(id))
    send = async options => ({ ...ack(options.data), ...change })
    assert.equal(await q.syncQueued(id), false)
    assert.equal(q.pendingEntries().find(row => row.id === id).status, 'ack_unverified')
  }
})

test('doctor can retry only an explicitly confirmed shared message and cannot use patient result queue routes', async () => {
  storage.current_user = { id: 7, role: 'researcher' }
  const q = queue(); q.enqueue(entry('doctor-confirmed'))
  assert.throws(() => q.enqueue({ id: 'forged-patient-result', kind: 'legacy_cognitive', route: '/patient/submit_cognitive_test',
    payload: { patient_id: 8, test_type: 'reaction', result_json: { test_run_id: 'forged' } } }))
  const unconfirmed = entry('doctor-unconfirmed'); unconfirmed.payload.confirmed = false
  assert.throws(() => q.enqueue(unconfirmed))
  assert.equal(await q.syncQueued('doctor-confirmed'), true)
  assert.equal(q.pendingEntries().length, 0)
})

test('original context metadata is immutable and failed persistence transmits no shared message', () => {
  const q = queue(), original = entry('message-fixed'); q.enqueue(original)
  assert.throws(() => q.enqueue({ ...original, expected_context_digest: 'f'.repeat(64) }), /冲突/)
  const write = wx.setStorageSync; wx.setStorageSync = () => { throw new Error('synthetic storage full') }
  try { assert.throws(() => q.enqueue(entry('message-unsaved')), /保存/) } finally { wx.setStorageSync = write }
  assert.deepEqual(q.pendingEntries().map(row => row.id), ['message-fixed']); assert.deepEqual(calls, [])
})
