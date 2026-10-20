// Original App -> durable queue -> real HTTP/temporary database. No native wx claim.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { setTimeout: pause } = require('node:timers/promises')
const root = path.resolve(__dirname, '../..')

function wire(url, method = 'GET', data, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk })
      res.on('end', () => { try { resolve({ statusCode: res.statusCode, data: JSON.parse(body) }) } catch (e) { reject(e) } })
    })
    req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
  })
}

test('automatic submission recovery preserves actual commits, timing, foreground and original owner', { timeout: 120000 }, async t => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_authorization_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let serverLog = '', app, callback, network = 'none', delayed, holdAck = false
  const previous = { wx: global.wx, App: global.App, getApp: global.getApp, getCurrentPages: global.getCurrentPages }
  const names = ['../app', '../utils/submission-recovery', '../utils/submission-queue', '../utils/request']
  const requests = [], acks = [], storage = {}, page = { route: 'pages/cognitive/index', data: { running: true } }
  const clone = value => value === undefined ? undefined : structuredClone(value)
  const api = async (route, auth, data, expected = 200) => {
    const result = await wire(base + route, data === undefined ? 'GET' : 'POST', data,
      auth ? { Authorization: `Bearer ${auth.access_token}` } : {})
    assert.equal(result.statusCode, expected, JSON.stringify(result.data)); return result.data
  }
  const register = label => api('/auth/register', null, { email: `recovery-${label}@example.org`, password: 'Synthetic#2026', full_name: 'Synthetic Recovery',
    role: 'patient', consent_agreed: true, patient_profile: { age: 26, patient_type: 'adult' } }, 201)
  let queue
  const enqueue = (auth, run) => queue.enqueue({ id: run, kind: 'legacy_cognitive', route: '/patient/submit_cognitive_test',
    payload: { patient_id: auth.user.patient_profile.id, test_type: 'reaction', result_json: { test_run_id: run, raw_result: { accuracy: 50 } } } })
  try {
    for (let i = 0; i < 300; i++) {
      if (server.exitCode !== null) throw new Error(serverLog)
      try { if ((await wire(base + '/care/assessment-templates')).statusCode === 401) break } catch (_) {}
      if (i === 299) throw new Error('Isolated server startup timeout')
      await pause(100)
    }
    const a = await register('a'), b = await register('b')
    Object.assign(storage, { current_user: a.user, access_token: a.access_token, api_base_url: base })
    global.wx = { getStorageSync: key => clone(storage[key]), setStorageSync: (key, value) => { storage[key] = clone(value) },
      removeStorageSync: key => { delete storage[key] }, showToast() {}, reLaunch() {},
      onNetworkStatusChange: handler => { callback = handler }, getNetworkType: options => options.success({ networkType: network }),
      request: options => {
        requests.push(clone({ url: options.url, data: options.data }))
        wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header).then(result => {
          const deliver = () => { acks.push(result); options.success(result) }
          if (holdAck) { holdAck = false; delayed = deliver } else deliver()
        }).catch(error => options.fail({ errMsg: error.message }))
      } }
    global.App = value => { app = value }; global.getApp = () => app; global.getCurrentPages = () => [page]
    for (const name of names) delete require.cache[require.resolve(name)]
    queue = require('../utils/submission-queue'); require('../app')
    enqueue(a, 'auto-one'); enqueue(a, 'auto-two'); app.onLaunch(); await app.onShow()
    await t.test('reconnect waits for actual timing, then real ACKs remove both exact persisted runs', async () => {
      network = 'wifi'; await callback({ isConnected: true, networkType: network })
      assert.equal(requests.length, 0)
      page.data.running = false; await app.onShow()
      assert.deepEqual(requests.map(row => row.data.result_json.test_run_id), ['auto-one', 'auto-two'])
      assert.equal(queue.pendingEntries().length, 0)
      assert.equal(acks.length, 2); assert.ok(acks.every(row => row.statusCode === 201 && row.data.id > 0))
      assert.notEqual(acks[0].data.id, acks[1].data.id)
    })
    await t.test('background does not send and repeated reconnects share one active recovery pass', async () => {
      enqueue(a, 'auto-three'); enqueue(a, 'auto-four'); const before = requests.length
      app.onHide(); await callback({ isConnected: true, networkType: network }); assert.equal(requests.length, before)
      holdAck = true; delayed = null
      const first = app.onShow()
      for (let i = 0; i < 300 && !delayed; i++) await pause(10)
      assert.equal(typeof delayed, 'function')
      const second = callback({ isConnected: true, networkType: network })
      assert.equal(requests.length, before + 1)
      delayed(); await Promise.all([first, second])
      assert.deepEqual(requests.slice(before).map(row => row.data.result_json.test_run_id), ['auto-three', 'auto-four'])
      assert.equal(queue.pendingEntries().length, 0)
    })
    await t.test('late real A ACK cannot remove B queue or continue A work using B credentials', async () => {
      enqueue(a, 'auto-old-owner'); enqueue(a, 'auto-old-next'); const before = requests.length
      holdAck = true; delayed = null
      const old = callback({ isConnected: true, networkType: network })
      for (let i = 0; i < 300 && !delayed; i++) await pause(10)
      assert.equal(typeof delayed, 'function')
      require('../utils/session-privacy').replacePatientSession({ access_token: b.access_token, user: b.user })
      enqueue(b, 'auto-new-owner'); delayed(); await old
      assert.equal(requests.length, before + 1)
      assert.deepEqual(queue.pendingEntries().map(row => row.id), ['auto-new-owner'])
      await callback({ isConnected: true, networkType: network })
      assert.equal(queue.pendingEntries().length, 0)
      assert.equal(requests.at(-1).data.patient_id, b.user.patient_profile.id)
    })
    await t.test('actual withdrawn authority stops this automatic pass and retains immutable unacknowledged runs', async () => {
      enqueue(b, 'auto-withdrawn-one'); enqueue(b, 'auto-withdrawn-two')
      const consents = await api('/patient/consents', b), basic = consents.items.find(row => row.purpose === 'basic_use' && row.status === 'active')
      assert.ok(basic)
      await api(`/patient/consents/${basic.id}/withdraw`, b, { expected_revision: basic.revision })
      const before = requests.length; await callback({ isConnected: true, networkType: network })
      assert.equal(requests.length, before + 1)
      assert.deepEqual(queue.pendingEntries().map(row => row.id), ['auto-withdrawn-one', 'auto-withdrawn-two'])
      assert.equal(queue.pendingEntries()[0].status, 'authorization_blocked')
      assert.equal(queue.pendingEntries()[1].status, 'pending_sync')
      assert.equal(acks.at(-1).statusCode, 403)
    })
  } finally {
    Object.assign(global, previous)
    for (const name of names) delete require.cache[require.resolve(name)]
    server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(path.join(root, 'docs/evidence/w04-auto-recovery-integration-server.txt'), serverLog)
  }
})
