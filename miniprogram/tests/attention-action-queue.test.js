const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
let storage, send, calls
const clone = value => value === undefined ? undefined : structuredClone(value)
const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true,
  exports: { request: options => { calls.push(options); return send(options) } } }
beforeEach(() => {
  storage = { access_token: 'synthetic-attention-A', current_user: { id: 7, role: 'patient', patient_profile: { id: 8 } } }
  global.wx = { getStorageSync: key => clone(storage[key]), setStorageSync: (key, value) => { storage[key] = clone(value) },
    removeStorageSync: key => { delete storage[key] }, showToast() {}, reLaunch() {} }
  calls = []; send = async options => ack(options.data)
  delete require.cache[require.resolve('../utils/submission-queue')]
})
// Shape fixture only: actual integration obtains the independent server signature.
const context = changes => 'attention-action-context.v1.' + Buffer.from(JSON.stringify({
  purpose: 'attention_action', version: 1, actor_user_id: 7, actor_identity_basis: 'self:7:access:1:revision:1',
  patient_id: 8, attention_id: 11, expected_version: 1, previous_status: 'open', authorization_snapshot: [], ...changes
})).toString('base64url') + '.' + 'a'.repeat(64)
const entry = (id, changes = {}) => ({ id, kind: 'attention_action', route: '/care/attention-actions', expected_context_digest: 'd'.repeat(64),
  payload: { patient_id: 8, attention_id: 11, client_action_id: id, expected_version: 1, action: 'acknowledge', reason: null,
    action_context: context(), confirmed: true, ...changes } })
const ack = body => ({ action_id: 20, client_action_id: body.client_action_id, attention_id: body.attention_id, patient_id: body.patient_id,
  actor_user_id: 7, actor_identity_basis: 'self:7:access:1:revision:1', action: body.action, reason: body.reason, previous_status: 'open',
  status: body.action === 'acknowledge' ? 'acknowledged' : body.action === 'resolve' ? 'resolved' : 'closed_with_reason',
  expected_version: body.expected_version, version: body.expected_version + 1, occurred_at: '2026-10-16T01:00:00.123456+00:00',
  action_context_digest: 'd'.repeat(64), authorization_snapshot: [], submission_status: 'committed', confirmed: true, legacy: false })
const queue = () => require('../utils/submission-queue')

test('attention actions persist the original context and recover one lost ACK using the original ID only', async () => {
  const q = queue(), original = entry('action-original')
  q.enqueue(original)
  send = async () => { throw new Error('synthetic lost ACK') }
  assert.equal(await q.syncQueued(original.id), false)
  delete require.cache[require.resolve('../utils/submission-queue')]
  send = async options => { assert.deepEqual(options, { url: '/care/attention-actions/action-original' }); return ack(original.payload) }
  const reopened = queue()
  assert.equal(await reopened.queryQueuedStatus(original.id), true)
  assert.deepEqual(reopened.pendingEntries(), [])
})

test('wrong actual actor, authority, original version, status, reason or time ACK never removes an attention original', async () => {
  const variations = [{ actor_user_id: 99 }, { actor_identity_basis: 'guardian:another' }, { patient_id: 9 }, { attention_id: 12 },
    { action_context_digest: 'e'.repeat(64) }, { expected_version: 2 }, { version: 9 }, { status: 'resolved' },
    { previous_status: 'acknowledged' }, { reason: '' }, { action: 'resolve' }, { occurred_at: 'unknown' },
    { authorization_snapshot: [[1]] }, { confirmed: false }, { legacy: true }]
  const q = queue()
  for (let index = 0; index < variations.length; index++) {
    const original = entry('action-wrong-' + index, { attention_id: 11 + index, action_context: context({ attention_id: 11 + index }) })
    q.enqueue(original)
    send = async options => ({ ...ack(options.data), ...variations[index] })
    assert.equal(await q.syncQueued(original.id), false, JSON.stringify(variations[index]))
    assert.deepEqual(q.pendingEntries().find(row => row.id === original.id).payload, original.payload)
  }
})

test('a doctor may queue only their confirmed action; blocked originals are not automatically retried or replaced', async () => {
  storage.current_user = { id: 7, role: 'researcher' }
  const q = queue(), original = entry('doctor-action')
  q.enqueue(original)
  assert.equal(require('../utils/session-privacy').summarizePatientData().pendingCount, 1)
  assert.throws(() => q.enqueue(entry('same-version-conflict')), /冲突|待确认/)
  assert.throws(() => q.enqueue(entry('unconfirmed', { confirmed: false })))
  assert.throws(() => q.enqueue(entry('no-reason', { attention_id: 12, action: 'resolve', reason: '  ' })))
  send = async () => { throw Object.assign(new Error('synthetic denied'), { statusCode: 403 }) }
  assert.equal(await q.syncQueued(original.id), false)
  calls = []; assert.equal(await q.retryPending(), 0); assert.deepEqual(calls, [])
  assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
  assert.throws(() => q.enqueue({ ...original, expected_context_digest: 'f'.repeat(64) }), /冲突/)
})

test('late A action confirmation cannot remove B original after actual account replacement', async () => {
  const q = queue(); q.enqueue(entry('account-A-action'))
  let finish
  send = options => new Promise(resolve => { finish = () => resolve(ack(options.data)) })
  const pending = q.syncQueued('account-A-action'); await Promise.resolve()
  require('../utils/session-privacy').replacePatientSession({ access_token: 'synthetic-B', user: { id: 9, role: 'patient', patient_profile: { id: 10 } } })
  const b = entry('account-B-action', { patient_id: 10, action_context: context({ actor_user_id: 9, patient_id: 10 }) })
  q.enqueue(b); finish()
  assert.equal(await pending, false)
  assert.deepEqual(q.pendingEntries().map(row => row.id), ['account-B-action'])
})
