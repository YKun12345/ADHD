const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
let storage, send, calls
const clone = value => value === undefined ? undefined : structuredClone(value)
const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true,
  exports: { request: options => { calls.push(options); return send(options) } } }
beforeEach(() => {
  storage = { access_token: 'synthetic-cycle-A', current_user: { id: 7, role: 'patient', patient_profile: { id: 8 } } }
  calls = []; send = async options => ack(options.data)
  global.wx = { getStorageSync: key => clone(storage[key]), setStorageSync: (key, value) => { storage[key] = clone(value) },
    removeStorageSync: key => { delete storage[key] }, showToast() {}, reLaunch() {} }
  delete require.cache[require.resolve('../utils/submission-queue')]
})
const queue = () => require('../utils/submission-queue')
const entry = (id, cycle = 21) => ({ id, kind: 'cycle_daily', route: '/care/daily-records', payload: {
  client_submission_id: id, patient_id: 8, cycle_id: cycle, record_date: '2026-10-14', expected_revision: 0,
  recorded_at: null, content: { focus_minutes: 0, note: '合成补录' } } })
const ack = body => ({ submission_status: 'committed', legacy: false, client_submission_id: body.client_submission_id,
  record_id: 90, patient_id: body.patient_id, cycle_id: body.cycle_id, record_date: body.record_date,
  revision: body.expected_revision + 1, expected_revision: body.expected_revision, actor_user_id: 7,
  recorded_at: body.recorded_at, content: body.content, content_digest: 'a'.repeat(64) })

test('same date in separate cycles stays separate and only its exact actual acknowledgement removes a record', async () => {
  const q = queue(); q.enqueue(entry('cycle-one')); q.enqueue(entry('cycle-two', 22))
  send = async () => { throw new Error('synthetic offline') }
  assert.equal(await q.syncQueued('cycle-one'), false)
  delete require.cache[require.resolve('../utils/submission-queue')]
  const reopened = queue(); send = async options => ({ ...ack(options.data), cycle_id: 999 })
  assert.equal(await reopened.syncQueued('cycle-two'), false)
  assert.equal(reopened.pendingEntries().length, 2)
  send = async options => ack(options.data)
  assert.equal(await reopened.syncQueued('cycle-two'), true)
  assert.deepEqual(reopened.pendingEntries().map(row => row.id), ['cycle-one'])
})

test('a real committed response lost in transport can be recovered by the original daily submission ID', async () => {
  const q = queue(), original = entry('cycle-lost-ack'); q.enqueue(original)
  send = async () => { throw new Error('synthetic lost ACK') }
  assert.equal(await q.syncQueued(original.id), false)
  send = async () => ack(original.payload)
  assert.equal(await q.queryQueuedStatus(original.id), true)
  assert.deepEqual(calls.at(-1), { url: '/care/daily-records/cycle-lost-ack' })
  assert.equal(q.pendingEntries().length, 0)
})

test('a conflicting unsent revision or an unapproved route cannot replace the saved daily original', () => {
  const q = queue(); q.enqueue(entry('cycle-original'))
  const conflict = entry('cycle-replacement'); conflict.payload.content.note = 'changed'
  assert.throws(() => q.enqueue(conflict), /冲突/)
  assert.throws(() => q.enqueue({ ...entry('bad-route'), route: '/care/cycles/21/publish' }), /无效/)
  assert.deepEqual(q.pendingEntries().map(row => row.id), ['cycle-original'])
  assert.deepEqual(calls, [])
})

test('a wrong revision ACK and withdrawn authority keep the original daily evidence and stop retrying', async () => {
  const q = queue(), original = entry('cycle-withdrawn'); q.enqueue(original)
  send = async options => ({ ...ack(options.data), revision: 2 })
  assert.equal(await q.syncQueued(original.id), false)
  send = async () => { throw Object.assign(new Error('synthetic withdrawal'), { statusCode: 403 }) }
  assert.equal(await q.retryPending(), 0)
  const count = calls.length; assert.equal(await q.retryPending(), 0); assert.equal(calls.length, count)
  assert.equal(q.pendingEntries()[0].status, 'authorization_blocked')
  assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
})

test('cycle creation survives a lost response and retries its immutable client cycle ID', async () => {
  const q = queue(), creation = { id: 'cycle-creation-id', kind: 'cycle_create', route: '/care/cycles',
    payload: { patient_id: 8, client_cycle_id: 'cycle-creation-id', cycle_type: 'self', start_date: '2026-10-01', end_date: '2026-10-14' } }
  q.enqueue(creation); send = async () => { throw new Error('synthetic response lost') }
  assert.equal(await q.syncQueued(creation.id), false)
  delete require.cache[require.resolve('../utils/submission-queue')]
  const reopened = queue()
  send = async options => ({ id: 21, ...options.data, actor_user_id: 7, calendar_timezone: 'Asia/Shanghai', responsible_doctor_id: 99, plan_version_id: null })
  assert.equal(await reopened.syncQueued(creation.id), false)
  send = async options => ({ id: 21, ...options.data, actor_user_id: 7, calendar_timezone: 'Asia/Shanghai', responsible_doctor_id: null, plan_version_id: null })
  assert.equal((await reopened.syncQueuedAcknowledgement(creation.id)).id, 21)
  assert.equal(reopened.pendingEntries().length, 0)
  assert.deepEqual(calls.at(-1).data, creation.payload)
})
