const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
let storage, transport, definition
const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true, exports: { request: options => transport(options) } }
const queue = require('../utils/submission-queue')
const ack = body => ({ id: 80, legacy: true, test_type: body.test_type, result_json: body.result_json })
beforeEach(() => {
  storage = { access_token: 'queue-page-A', current_user: { id: 7, role: 'patient', patient_profile: { id: 8 } } }
  global.wx = { getStorageSync: key => storage[key] === undefined ? undefined : structuredClone(storage[key]),
    setStorageSync: (key, value) => { storage[key] = structuredClone(value) }, removeStorageSync: key => { delete storage[key] },
    showToast() {}, navigateTo() {}, reLaunch() {} }
  global.Page = value => { definition = value }
  global.getCurrentPages = () => []
  transport = async options => ack(options.data)
})
const enqueue = id => queue.enqueue({ id, kind: 'legacy_cognitive', route: '/patient/submit_cognitive_test',
  payload: { patient_id: 8, test_type: 'flanker', result_json: { test_run_id: `run-${id}`, raw_result: { accuracy: 50 } } } })
function page() {
  const file = require.resolve('../pages/submission-queue/index'); delete require.cache[file]; require(file)
  const value = { ...definition, data: structuredClone(definition.data), setData(changes) { Object.assign(this.data, changes) } }
  global.getCurrentPages = () => [value]
  value.onLoad({}); return value
}
const event = id => ({ currentTarget: { dataset: { id } } })

test('reopened recovery page reads both durable runs and only removes the acknowledged row', async () => {
  enqueue('one'); enqueue('two')
  const current = page(); assert.equal(current.data.entries.length, 2)
  assert.equal(await current.retry(event('two')), true)
  assert.deepEqual(current.data.entries.map(item => item.id), ['one'])
  assert.deepEqual(queue.pendingEntries().map(item => item.id), ['one'])
})

test('same-account hide/show prevents the old response from changing a newer recovery operation', async () => {
  enqueue('one'); enqueue('two')
  const pending = []
  transport = options => new Promise(resolve => pending.push(() => resolve(ack(options.data))))
  const current = page(), first = current.retry(event('one')); await Promise.resolve()
  current.onHide(); current.onShow()
  const second = current.retry(event('two')); await Promise.resolve()
  pending[0](); const oldResult = await first, remainedBusy = current.data.busy
  pending[1](); await second
  assert.equal(oldResult, false)
  assert.equal(remainedBusy, true)
})

test('real account replacement scrubs the recovery page and a late A ACK cannot restore it', async () => {
  enqueue('one')
  let complete
  transport = options => new Promise(resolve => { complete = () => resolve(ack(options.data)) })
  const current = page(), old = current.retry(event('one')); await Promise.resolve()
  const { replacePatientSession } = require('../utils/session-privacy')
  replacePatientSession({ access_token: 'queue-page-B', user: { id: 9, role: 'patient', patient_profile: { id: 10 } } })
  complete(); assert.equal(await old, false)
  assert.deepEqual(current.data.entries, [])
  assert.deepEqual(queue.pendingEntries(), [])
})
