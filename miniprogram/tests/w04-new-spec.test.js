// Independent real request -> temporary HTTP/API/SQLite queue checks; no native WeChat claim.
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
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk })
      res.on('end', () => { try { resolve({ statusCode: res.statusCode, data: JSON.parse(text) }) } catch (e) { reject(e) } })
    })
    req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
  })
}

test('independent queue survives real committed ACK loss, selected ACK, conflict and storage rejection', { timeout: 120000 }, async t => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const origin = `http://127.0.0.1:${port}`, base = `${origin}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_authorization_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let serverLog = '', requests = 0, loseAck = false
  server.stdout.on('data', value => { serverLog += value }); server.stderr.on('data', value => { serverLog += value })
  const previousWx = global.wx
  try {
    for (let i = 0; i < 300; i++) {
      if (server.exitCode !== null) throw new Error(serverLog)
      try { if ((await wire(`${base}/care/assessment-templates`)).statusCode === 401) break } catch (_) {}
      if (i === 299) throw new Error('Synthetic server startup timeout: ' + serverLog)
      await pause(100)
    }
    const registration = await wire(`${base}/auth/register`, 'POST', { email: 'w04-new-spec-queue@example.org', full_name: 'Synthetic Queue User',
      password: 'Synthetic#2026', role: 'patient', consent_agreed: true, patient_profile: { age: 26, patient_type: 'adult' } })
    assert.equal(registration.statusCode, 201, JSON.stringify(registration.data))
    const auth = registration.data, pid = auth.user.patient_profile.id
    const headers = { Authorization: `Bearer ${auth.access_token}` }
    const api = async (route, data, expected = 200) => {
      const response = await wire(base + route, data === undefined ? 'GET' : 'POST', data, headers)
      assert.equal(response.statusCode, expected, JSON.stringify(response.data)); return response.data
    }
    const template = (await api(`/care/assessment-templates?patient_id=${pid}`)).items[0]
    const assessment = await api('/care/patient/assessments', { patient_id: pid, template_id: template.id, template_version: template.version, background: {} }, 201)
    const storage = { current_user: auth.user, access_token: auth.access_token, api_base_url: base }
    const clone = value => value === undefined ? undefined : structuredClone(value)
    global.wx = { getStorageSync: key => clone(storage[key]), setStorageSync: (key, value) => { storage[key] = clone(value) },
      removeStorageSync: key => { delete storage[key] }, showToast() {}, reLaunch() {},
      request: options => { requests++; wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header)
        .then(response => { if (loseAck && options.method === 'POST' && response.statusCode === 201) { loseAck = false; options.fail({ errMsg: 'synthetic ACK lost after real commit' }) }
          else options.success(response) }).catch(error => options.fail({ errMsg: error.message })) } }
    for (const name of ['request', 'submission-queue', 'assessment-execution']) delete require.cache[require.resolve(`../utils/${name}`)]
    const queue = require('../utils/submission-queue')
    async function freshSubmission(id) {
      const current = await api(`/care/assessments/${assessment.id}`), item = current.items.find(row => row.kind === 'scale')
      const attempt = await api(`/care/assessment-items/${item.id}/attempts`, { expected_item_version: item.version,
        protocol_id: item.protocol_id, protocol_schema_version: item.protocol_schema_version, config_digest: item.config_digest,
        performer_patient_id: null, respondent_kind: item.respondent_kind, confirmed: true, device: { platform: 'miniprogram', device_type: 'phone', viewport_width: 390, viewport_height: 844 },
        input: { method: 'touch' }, timing: { clock_source: 'Date.now', unit: 'ms' }, practice: { completed: true, attempts: 1, exposure_count: 0 }, assistance: { provided: false, kind: 'none' }, recall_window: 'P6M' }, 201)
      const payload = { submission_id: id, kind: 'scale', patient_id: pid, assessment_id: assessment.id, assessment_item_id: item.id,
        attempt_id: attempt.id, run_id: attempt.run_id, task_id: null,
        content: { scale_type: 'ASRS', answers: Array(18).fill(0), recall_window: 'P6M', content_digest: item.content_digest } }
      for (const key of ['protocol_id', 'protocol_schema_version', 'config_digest', 'template_digest', 'actor_user_id', 'performer_kind', 'performer_user_id', 'performer_patient_id', 'respondent_user_id', 'respondent_kind', 'submitter_user_id']) payload[key] = attempt[key]
      return { id, kind: 'assessment', route: '/care/submissions', payload }
    }
    await t.test('actual committed ACK loss is recovered by original submission query and actual evidence', async () => {
      const entry = await freshSubmission('new-spec-lost-ack'); queue.enqueue(entry); loseAck = true
      assert.equal(await queue.syncQueued(entry.id), false)
      assert.equal(queue.pendingEntries().length, 1)
      assert.equal(await queue.queryQueuedStatus(entry.id), true)
      assert.equal(queue.pendingEntries().length, 0)
      const evidence = await api(`/care/submissions/${entry.id}/evidence`)
      assert.deepEqual(evidence.client_evidence.answers, Array(18).fill(0))
      assert.equal(evidence.context.attempt_id, entry.payload.attempt_id)
      assert.equal(evidence.server_result.total_score, 0)
    })
    await t.test('two persisted attempts survive module reload and a real second ACK removes only second', async () => {
      const first = await freshSubmission('new-spec-first'), second = await freshSubmission('new-spec-second')
      queue.enqueue(first); queue.enqueue(second)
      delete require.cache[require.resolve('../utils/submission-queue')]
      const reopened = require('../utils/submission-queue')
      assert.equal(await reopened.syncQueued(second.id), true)
      assert.deepEqual(reopened.pendingEntries().map(row => row.id), [first.id])
      assert.equal(await reopened.syncQueued(first.id), true)
    })
    await t.test('real conflicting context retains original immutable evidence without reassignment', async () => {
      const entry = await freshSubmission('new-spec-conflict'); entry.payload.config_digest = 'f'.repeat(64)
      queue.enqueue(entry); assert.equal(await queue.syncQueued(entry.id), false)
      const pending = queue.pendingEntries().find(row => row.id === entry.id)
      assert.equal(pending.status, 'conflict_blocked'); assert.deepEqual(pending.payload, entry.payload)
      assert.equal((await wire(base + '/care/submissions/' + entry.id, 'GET', undefined, headers)).statusCode, 404)
    })
    await t.test('failed persistent write transmits no request and leaves earlier evidence', async () => {
      const entry = await freshSubmission('new-spec-full'), before = requests, oldWrite = wx.setStorageSync
      wx.setStorageSync = () => { throw new Error('synthetic quota') }
      try { assert.throws(() => queue.enqueue(entry), /保存/) } finally { wx.setStorageSync = oldWrite }
      assert.equal(requests, before); assert.deepEqual(queue.pendingEntries().map(row => row.id), ['new-spec-conflict'])
    })
  } finally {
    global.wx = previousWx; server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(path.join(root, 'docs/evidence/w04-new-spec-mini-server.txt'), serverLog)
  }
})
