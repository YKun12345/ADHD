// Original application lifecycle and durable queue; no fabricated successful ACK.
const { test } = require('node:test')
const assert = require('node:assert/strict')

test('real application reconnect retries both durable runs without requiring a recovery-page click', async () => {
  const oldWx = global.wx, oldApp = global.App, oldPages = global.getCurrentPages
  const storage = { access_token: 'quality-synthetic-token', current_user: {
    id: 7, role: 'patient', patient_profile: { id: 8, patient_type: 'adult' }
  } }
  const networkHandlers = [], requests = []
  let networkType = 'none'
  const cognitivePage = { route: 'pages/cognitive/index', data: { running: true }, _execution: {} }
  let app
  const clone = value => value === undefined ? undefined : structuredClone(value)
  global.wx = {
    getStorageSync: key => clone(storage[key]),
    setStorageSync: (key, value) => { storage[key] = clone(value) },
    removeStorageSync: key => { delete storage[key] },
    onNetworkStatusChange: callback => networkHandlers.push(callback),
    getNetworkType: options => options.success({ networkType }),
    request: options => { requests.push(options); options.fail({ errMsg: 'synthetic network still unavailable' }) },
    showToast() {}, reLaunch() {}
  }
  global.App = definition => { app = definition }
  global.getCurrentPages = () => [cognitivePage]
  const names = ['../app', '../utils/request', '../utils/submission-queue']
  for (const name of names) delete require.cache[require.resolve(name)]
  try {
    const queue = require('../utils/submission-queue')
    for (const id of ['quality-run-one', 'quality-run-two']) queue.enqueue({
      id, kind: 'legacy_cognitive', route: '/patient/submit_cognitive_test',
      payload: { patient_id: 8, test_type: 'reaction', result_json: { test_run_id: id, raw_result: { accuracy: 50 } } }
    })
    require('../app')
    await app.onLaunch()
    if (app.onShow) await app.onShow()
    assert.ok(networkHandlers.length > 0, 'The original App must subscribe to reconnect events so its durable queue can resume automatically.')
    networkType = 'wifi'
    for (const callback of networkHandlers) await callback({ isConnected: true, networkType: 'wifi' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests.length, 0, 'Automatic transport must defer during actual cognitive timing.')
    cognitivePage.data.running = false
    if (app.onShow) await app.onShow()
    for (let i = 0; i < 20 && requests.length < 2; i++) await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(requests.map(row => row.data.result_json.test_run_id), ['quality-run-one', 'quality-run-two'])
    assert.equal(queue.pendingEntries().length, 2, 'Failed network transport cannot acknowledge either original run.')
  } finally {
    for (const name of names) delete require.cache[require.resolve(name)]
    global.wx = oldWx; global.App = oldApp; global.getCurrentPages = oldPages
  }
})
