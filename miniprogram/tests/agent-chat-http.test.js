const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), net = require('node:net')
const { spawn } = require('node:child_process'), { setTimeout: pause } = require('node:timers/promises')
const { createHarness } = require('./helpers/cognitive-harness')
const root = path.resolve(__dirname, '../..')
const wire = (url, method = 'GET', data, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, response => {
    let body = ''; response.on('data', value => { body += value }); response.on('end', () => {
      try { resolve({ statusCode: response.statusCode, data: JSON.parse(body) }) } catch (error) { reject(error) }
    })
  }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
})

test('actual mini chat recovers a committed lost ACK, queries the private real rule artifact, and clears on hide or actor change', { timeout: 140000 }, async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', h, page, doc; const traffic = []; let loseAck = true
  server.stdout.on('data', value => { log += value }); server.stderr.on('data', value => { log += value })
  async function api(route, auth, body, expected = 200) {
    const response = await wire(base + route, body === undefined ? 'GET' : 'POST', body,
      { ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}), ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w06-local-synthetic-only' } : {}) })
    assert.equal(response.statusCode, expected, JSON.stringify(response.data)); return response.data
  }
  async function completed(view) {
    for (let n = 0; n < 100; n++) {
      const row = view.data.runs.at(-1)
      if (row && !['queued', 'running'].includes(row.status)) return row
      clearTimeout(view._pollTimer); await view.refreshRun(); await pause(80)
    }
    throw new Error(`Real background did not finish: ${JSON.stringify(view.data)}`)
  }
  try {
    for (let n = 0; n < 300; n++) {
      if (server.exitCode !== null) throw new Error(log)
      try { if ((await wire(base + '/care/assessment-templates')).statusCode === 401) break } catch (_) {}
      if (n === 299) throw new Error('Synthetic startup timeout'); await pause(100)
    }
    const { owner, doctor, assessment } = await api('/__synthetic__/review-source', null, { child: true })
    const before = await api(`/care/assessments/${assessment.id}`, owner)
    h = createHarness(); h.restore(); Object.assign(h.storage, { current_user: owner.user, access_token: owner.access_token, api_base_url: base })
    delete require.cache[require.resolve('../utils/request')]
    wx.request = async options => {
      try {
        traffic.push({ url: options.url, method: options.method })
        const result = await wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header)
        if (loseAck && options.url === `${base}/agent/runs` && options.method === 'POST' && result.statusCode === 202) {
          loseAck = false; options.fail({ errMsg: 'synthetic response lost after actual commit' }); return
        }
        options.success(result)
      } catch (error) { options.fail({ errMsg: error.message }) }
    }
    const options = { query: { patient_id: String(assessment.patient_id), assessment_id: String(assessment.id) } }
    page = h.load('agent-chat', options); await page._loadPromise
    assert.equal(page.data.errorText, ''); assert.deepEqual(page.data.runs, [])
    page.selectIntent({ detail: { value: '1' } }); page.onInput({ detail: { value: '请核对本轮实际保存的材料。' } })
    assert.equal(await page.send(), false); assert.ok(page.data.pendingId)
    const originalId = page.data.pendingId
    assert.equal(await page.queryPending(), true, page.data.errorText); assert.equal(page.data.pendingId, '')
    const run = await completed(page)
    assert.equal(run.status, 'completed'); assert.equal(run.modeLabel, '规则模式'); assert.equal(run.artifact.status, 'draft')
    assert.equal(run.artifact.body.summary.limited_submissions, 1); assert.equal(run.artifact.body.summary.valid_submissions, 0)
    assert.ok(run.sourceText.includes('本轮实际提交原件')); assert.ok(run.summaryText.includes('有局限 1 份'))
    assert.equal(traffic.filter(row => row.url === `${base}/agent/runs` && row.method === 'POST').length, 1)
    assert.ok(traffic.some(row => row.url === `${base}/agent/runs/submissions/${originalId}` && row.method === 'GET'))
    await api(`/agent/runs/${run.run_id}`, doctor, undefined, 403)
    page.onHide(); assert.deepEqual(page.data.runs, []); assert.equal(page.data.inputValue, '')
    await page.onShow(); assert.equal(page.data.runs.at(-1).run_id, run.run_id)
    require('../utils/session-privacy').replacePatientSession({ access_token: doctor.access_token, user: doctor.user })
    assert.equal(await page.send(), false); assert.deepEqual(page.data.runs, [])
    doc = h.load('agent-chat', options); await doc._loadPromise; assert.deepEqual(doc.data.runs, [])
    doc.onInput({ detail: { value: '当前实际审核材料还有哪些局限？' } }); assert.equal(await doc.send(), true, doc.data.errorText)
    const doctorRun = await completed(doc); assert.equal(doctorRun.status, 'completed'); assert.notEqual(doctorRun.run_id, run.run_id)
    assert.equal(doctorRun.actor_user_id, doctor.user.id); assert.equal(doctorRun.artifact.body.summary.limited_submissions, 1)
    const after = await api(`/care/assessments/${assessment.id}`, owner)
    assert.equal(after.version, before.version); assert.deepEqual(after.items, before.items)
    fs.writeFileSync(path.join(root, 'docs/evidence/w08-agent-chat-mini-http-receipt.json'), JSON.stringify({
      actual_tcp_http: true, actual_mini_page_queue_and_request: true, synthetic_temporary_stores: true, native_wechat_verified: false,
      guardian_run_id: run.run_id, doctor_private_run_id: doctorRun.run_id, committed_lost_ack_recovered_get_only: true,
      other_actor_private_run_rejected: true, actor_switch_and_hide_clear: true, business_state_unchanged: true,
      mode: 'rules', real_model_called: false
    }, null, 2))
  } finally {
    page?.onUnload(); doc?.onUnload(); h?.restore(); server.kill()
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(path.join(root, 'docs/evidence/w08-agent-chat-mini-http-server.txt'), log)
  }
})
