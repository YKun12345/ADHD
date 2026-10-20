const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { syntheticSendContext, readSyntheticContext } = require('./helpers/shared-message-context')
let storage, definition, transport, calls, navigations
const clone = value => value === undefined ? undefined : structuredClone(value)
const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true,
  exports: { request: options => { calls.push(options); return transport(options) } } }
const queue = require('../utils/submission-queue')
const { summarizePatientData, replacePatientSession } = require('../utils/session-privacy')
beforeEach(() => {
  storage = { access_token: 'synthetic-doctor-recovery-A', current_user: { id: 7, role: 'researcher' } }
  calls = []; navigations = []
  global.wx = { getStorageSync: key => clone(storage[key]), setStorageSync: (key, value) => { storage[key] = clone(value) },
    removeStorageSync: key => { delete storage[key] }, reLaunch() {}, showToast() {}, navigateTo: options => navigations.push(options.url) }
  global.Page = value => { definition = value }; global.getCurrentPages = () => []
  transport = async options => ack(options.data)
})
function entry(id, relationshipId = 21) {
  return { id, kind: 'shared_message', route: '/care/shared-messages', expected_context_digest: 'd'.repeat(64), expected_relationship_revision: 2,
    payload: { patient_id: 8, relationship_id: relationshipId, client_message_id: id, content: '合成本人已确认的医生回复',
      confirmed: true, reply_to_message_id: null, send_context: syntheticSendContext({ relationship_id: relationshipId, doctor_user_id: 7,
        patient_actor_user_id: 42, sender_identity_basis: 'doctor:7:qualification:1:revision:1' }) } }
}
const ack = body => ({ ...body, message_id: 80, sender_user_id: 7, sender_kind: 'doctor', relationship_revision: 2, version: 1,
  doctor_user_id: readSyntheticContext(body.send_context).doctor_user_id, patient_actor_user_id: readSyntheticContext(body.send_context).patient_actor_user_id,
  sender_identity_basis: readSyntheticContext(body.send_context).sender_identity_basis,
  scope: ['care'], authorization_snapshot: readSyntheticContext(body.send_context).authorization_snapshot, sent_at: '2026-10-16T00:00:00+00:00',
  confirmed: true, send_context_digest: 'd'.repeat(64), content_digest: 'a'.repeat(64), context_digest: 'b'.repeat(64),
  submission_status: 'committed', legacy: false })
function page() {
  const file = require.resolve('../pages/submission-queue/index'); delete require.cache[file]; require(file)
  const result = { ...definition, data: clone(definition.data), setData(changes) { Object.assign(this.data, changes) } }
  global.getCurrentPages = () => [result]; result.onLoad({}); return result
}
const event = id => ({ currentTarget: { dataset: { id } } })

test('doctor recovery exposes original recipient and can query one ACK without resending or clearing another message', async () => {
  queue.enqueue(entry('doctor-A')); queue.enqueue(entry('doctor-B', 22))
  const current = page()
  assert.equal(current.data.entries.length, 2)
  assert.equal(current.data.fallbackUrl, '/pages/doctor-home/index')
  assert.equal(current.data.entries[0].title, '已确认共享消息')
  assert.match(current.data.entries[0].sourceLabel, /8.*21/)
  assert.equal(current.data.entries[1].canQuery, true)
  transport = async options => {
    assert.equal(options.url, '/care/shared-messages/submissions/doctor-B')
    assert.equal(options.method, undefined); return ack(entry('doctor-B', 22).payload)
  }
  assert.equal(await current.queryStatus(event('doctor-B')), true)
  assert.deepEqual(current.data.entries.map(row => row.id), ['doctor-A'])
  current.openPrivacy(); assert.deepEqual(navigations, ['/pages/doctor-guide-settings/index'])
})

test('hidden doctor recovery cannot send and revoked original receipt stays on its original relationship', async () => {
  queue.enqueue(entry('doctor-blocked')); const current = page(); current.onHide()
  assert.equal(await current.retry(event('doctor-blocked')), false); assert.equal(calls.length, 0)
  current.onShow(); transport = async () => { throw Object.assign(new Error('synthetic old authority revoked'), { statusCode: 403 }) }
  assert.equal(await current.retry(event('doctor-blocked')), false)
  assert.equal(queue.pendingEntries()[0].status, 'authorization_blocked')
  assert.equal(queue.pendingEntries()[0].payload.send_context, entry('doctor-blocked').payload.send_context)
  assert.equal(queue.pendingEntries()[0].payload.relationship_id, 21)
})

test('real doctor account replacement ends the recovery page and a late ACK cannot restore or navigate it', async () => {
  queue.enqueue(entry('doctor-late')); const current = page(); let complete
  transport = options => new Promise(resolve => { complete = () => resolve(ack(options.data)) })
  const old = current.retry(event('doctor-late')); await Promise.resolve()
  replacePatientSession({ access_token: 'synthetic-doctor-recovery-B', user: { id: 9, role: 'researcher' } })
  complete(); assert.equal(await old, false)
  current.onShow(); current.openPrivacy()
  assert.deepEqual(current.data.entries, []); assert.deepEqual(navigations, [])
  assert.deepEqual(queue.pendingEntries(), [])
})

test('same token with a changed actor cannot reuse the old recovery page', () => {
  queue.enqueue(entry('doctor-fixed')); const current = page(); current.onHide()
  storage.current_user = { id: 9, role: 'researcher' }
  delete storage.submission_queue_v1
  queue.enqueue(entry('doctor-other'))
  current.onShow(); assert.deepEqual(current.data.entries, [])
  current.openPrivacy(); assert.deepEqual(navigations, [])
})

test('privacy count includes only the actual doctor shared queue and never another actor or origin', () => {
  queue.enqueue(entry('doctor-count'))
  assert.equal(summarizePatientData().pendingCount, 1)
  storage.current_user = { id: 9, role: 'researcher' }; assert.equal(summarizePatientData().pendingCount, 0)
  storage.current_user = { id: 7, role: 'researcher' }; storage.api_base_url = 'https://synthetic.invalid/api/v1'
  assert.equal(summarizePatientData().pendingCount, 0)
})
