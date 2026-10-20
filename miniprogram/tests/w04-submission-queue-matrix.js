// W04 TDD preparation; promoted to default regression when queue implementation starts.
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
let storage, send, calls, write
const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true,
  exports: { request: options => { calls.push(options); return send(options) } } }
const clone = value => value === undefined ? undefined : structuredClone(value)
beforeEach(() => {
  storage = { access_token: 'synthetic-queue-A', current_user: { id: 7, role: 'patient', patient_profile: { id: 8 } } }
  calls = []
  write = (key, value) => { storage[key] = clone(value) }
  send = async options => ack(options.data)
  global.wx = { getStorageSync: key => clone(storage[key]), setStorageSync: (key, value) => write(key, value),
    removeStorageSync: key => { delete storage[key] }, showToast() {}, reLaunch() {} }
})
const queue = () => require('../utils/submission-queue')
const payload = id => ({ submission_id: id, kind: 'scale', patient_id: 8, assessment_id: 20, assessment_item_id: 21,
  attempt_id: id === 'one' ? 31 : id === 'two' ? 32 : id === 'overflow' ? 10000 : 100 + Number(id.split('-').pop()), run_id: `server-${id}`, task_id: null, protocol_id: 'project-legacy-scale-v1',
  protocol_schema_version: 1, config_digest: 'a'.repeat(64), template_digest: 'b'.repeat(64), actor_user_id: 7,
  performer_kind: 'user', performer_user_id: 7, performer_patient_id: null, respondent_user_id: 7,
  respondent_kind: 'self', submitter_user_id: 7, content: { scale_type: 'ASRS', answers: Array(18).fill(0), recall_window: 'P6M', content_digest: 'c'.repeat(64) } })
const entry = id => ({ id, kind: 'assessment', route: '/care/submissions', payload: payload(id) })
function ack(body) { return { submission_id: body.submission_id, patient_id: body.patient_id, assessment_id: body.assessment_id,
  assessment_item_id: body.assessment_item_id, attempt_id: body.attempt_id, run_id: body.run_id, task_id: body.task_id,
  canonical_digest: 'd'.repeat(64), submission_status: 'committed', result: { kind: 'scale', id: 80, legacy: false },
  execution_status: 'submitted', quality_status: 'valid', acceptance_status: 'not_required' } }

test('two offline attempts survive queue-module reload and ACK of the second removes only that attempt', async () => {
  const q = queue(); q.enqueue(entry('one')); q.enqueue(entry('two'))
  send = async () => { throw Object.assign(new Error('synthetic offline'), { code: 'NETWORK_ERROR' }) }
  assert.equal(await q.syncQueued('one'), false); assert.equal(await q.syncQueued('two'), false)
  delete require.cache[require.resolve('../utils/submission-queue')]
  const restarted = queue(); assert.deepEqual(restarted.pendingEntries().map(item => item.id), ['one', 'two'])
  send = async options => ack(options.data)
  assert.equal(await restarted.syncQueued('two'), true)
  assert.deepEqual(restarted.pendingEntries().map(item => item.id), ['one'])
})

test('a storage exception or a silent write failure prevents transmission and never claims pending persistence', async () => {
  const q = queue()
  write = () => { throw new Error('synthetic storage full') }
  assert.throws(() => q.enqueue(entry('one')), /保存|storage/i)
  write = () => {}
  assert.throws(() => q.enqueue(entry('one')), /保存|storage/i)
  assert.deepEqual(calls, [])
  assert.deepEqual(q.pendingEntries(), [])
})

test('capacity exhaustion retains every older unacknowledged payload', () => {
  const q = queue()
  for (let n = 0; n < q.MAX_ENTRIES; n++) q.enqueue(entry(`capacity-${n}`))
  assert.throws(() => q.enqueue(entry('overflow')), /容量|queue.*full/i)
  assert.equal(q.pendingEntries().length, q.MAX_ENTRIES)
  assert.equal(q.pendingEntries()[0].id, 'capacity-0')
})

test('mutating the caller payload or reusing an ID with different answers cannot change the stored evidence', () => {
  const q = queue(), first = entry('one'); q.enqueue(first)
  first.payload.content.answers[0] = 4
  assert.equal(q.pendingEntries()[0].payload.content.answers[0], 0)
  assert.throws(() => q.enqueue(first), /冲突|immutable|conflict/i)
  assert.equal(q.pendingEntries()[0].payload.content.answers[0], 0)
})

test('an acknowledgement lost after server commit retries the identical immutable submission', async () => {
  const q = queue(); q.enqueue(entry('one'))
  let saved
  send = async options => { saved = clone(options.data); throw new Error('synthetic ACK lost after commit') }
  assert.equal(await q.syncQueued('one'), false)
  send = async options => { assert.deepEqual(options.data, saved); return ack(saved) }
  assert.equal(await q.syncQueued('one'), true)
  assert.deepEqual(q.pendingEntries(), [])
})

test('a different submission ID cannot add a second payload for an already queued attempt and run', () => {
  const q = queue(); q.enqueue(entry('one'))
  const duplicate = entry('two'); duplicate.payload.attempt_id = 31; duplicate.payload.run_id = 'server-one'
  assert.throws(() => q.enqueue(duplicate), /冲突|immutable|conflict/i)
  assert.deepEqual(q.pendingEntries().map(item => item.id), ['one'])
})

test('a wrong-context ACK and a withdrawn authorization do not delete or reassign pending evidence', async () => {
  const q = queue(); q.enqueue(entry('one'))
  send = async options => ({ ...ack(options.data), attempt_id: 999 })
  assert.equal(await q.syncQueued('one'), false)
  assert.equal(q.pendingEntries().length, 1)
  send = async () => { throw Object.assign(new Error('synthetic authorization withdrawn'), { statusCode: 403 }) }
  assert.equal(await q.syncQueued('one'), false)
  assert.equal(q.pendingEntries()[0].status, 'authorization_blocked')
  assert.deepEqual(q.pendingEntries()[0].payload, payload('one'))
})

test('a late A acknowledgement after real B session replacement cannot delete a new B queue entry', async () => {
  const q = queue(); q.enqueue(entry('one'))
  let resolve
  send = () => new Promise(done => { resolve = done })
  const old = q.syncQueued('one'); await Promise.resolve()
  assert.equal(typeof resolve, 'function')
  const { replacePatientSession } = require('../utils/session-privacy')
  replacePatientSession({ access_token: 'synthetic-queue-B', user: { id: 9, role: 'patient', patient_profile: { id: 10 } } })
  const next = entry('two'); next.payload.patient_id = 10; next.payload.actor_user_id = 9; next.payload.performer_user_id = 9
  next.payload.respondent_user_id = 9; next.payload.submitter_user_id = 9; q.enqueue(next)
  resolve(ack(payload('one'))); assert.equal(await old, false)
  assert.deepEqual(q.pendingEntries().map(item => item.id), ['two'])
  assert.equal(q.pendingEntries()[0].payload.patient_id, 10)
})
