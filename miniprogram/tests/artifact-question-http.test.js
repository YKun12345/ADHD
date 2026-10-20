const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), net = require('node:net')
const { spawn } = require('node:child_process'), { setTimeout: pause } = require('node:timers/promises')
const { createHarness } = require('./helpers/cognitive-harness')
const root = path.resolve(__dirname, '../..')
const wire = (url, method = 'GET', data, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, response => {
    let body = ''; response.on('data', value => { body += value }); response.on('end', () => { try { resolve({ statusCode: response.statusCode, data: JSON.parse(body) }) } catch (error) { reject(error) } })
  }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
})
test('actual mini doctor edits a real artifact, recovers both lost ACKs and separately confirms its one real guardian question', { timeout: 210000 }, async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', h, agent, form, guardian; const traffic = [], navigation = [], lost = new Set()
  server.stdout.on('data', value => { log += value }); server.stderr.on('data', value => { log += value })
  async function api(route, auth, body, expected = 200) {
    const result = await wire(base + route, body === undefined ? 'GET' : 'POST', body, { ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
      ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w06-local-synthetic-only' } : {}) })
    assert.equal(result.statusCode, expected, JSON.stringify(result.data)); return result.data
  }
  try {
    for (let n = 0; n < 300; n++) { if (server.exitCode !== null) throw new Error(log)
      try { if ((await wire(base + '/care/assessment-templates')).statusCode === 401) break } catch (_) {}
      if (n === 299) throw new Error('Synthetic startup timeout'); await pause(100) }
    const { owner, doctor, assessment } = await api('/__synthetic__/review-source', null, { child: true })
    h = createHarness(); h.restore(); Object.assign(h.storage, { current_user: doctor.user, access_token: doctor.access_token, api_base_url: base })
    delete require.cache[require.resolve('../utils/request')]
    wx.request = async options => {
      try {
        traffic.push({ method: options.method, url: options.url })
        const result = await wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header)
        if (options.method === 'POST' && result.statusCode === 201 && ['/agent/artifact-decisions','/care/clarifications'].some(route => options.url === base + route) && !lost.has(options.url)) {
          lost.add(options.url); options.fail({ errMsg: 'synthetic committed ACK lost' }); return
        }
        options.success(result)
      } catch (error) { options.fail({ errMsg: error.message }) }
    }
    wx.navigateTo = options => navigation.push(options.url); wx.showModal = options => options.success({ confirm: true })
    const options = { query: { patient_id: String(assessment.patient_id), assessment_id: String(assessment.id) } }
    agent = h.load('agent-chat', options); await agent._loadPromise
    assert.equal(agent.data.assessmentId, assessment.id, agent.data.errorText)
    agent.selectIntent({ detail: { value: String(agent.data.intents.findIndex(row => row.value === 'review_questions')) } })
    agent.onInput({ detail: { value: '请针对本轮有局限的实际原件准备具体补问。' } }); assert.equal(await agent.send(), true, agent.data.errorText)
    for (let n = 0; n < 120 && ['queued','running'].includes(agent.data.runs.at(-1)?.status); n++) { clearTimeout(agent._pollTimer); await agent.refreshRun(); await pause(80) }
    const artifact = agent.data.runs.at(-1).artifact; assert.ok(artifact && artifact.body.questions.length)
    assert.equal(await agent.openEditor({ currentTarget: { dataset: { id: artifact.id } } }), true, agent.data.errorText)
    const edited = '请补充这次操作中断时的实际情况；不知道或不便提供可以说明。'
    for (const [field,value] of [['editorText',edited],['editorReason','本人核对原件后修改提问内容。']]) agent.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } })
    assert.equal(await agent.saveEditor({ currentTarget: { dataset: { action: 'use' } } }), false)
    assert.ok(agent.data.pendingId); assert.equal((await api(`/care/assessments/${assessment.id}/clarifications`, owner)).items.length, 0)
    assert.equal(await agent.queryPending(), true, agent.data.errorText)
    const decision = agent.data.adoptedDecision; assert.ok(decision && decision.content.question === edited)
    assert.equal(agent.openDecision(), true); assert.ok(navigation.at(-1).endsWith('ai_decision_id=' + decision.id))
    form = h.load('review-questions', { query: { ...options.query, ai_decision_id: String(decision.id) } }); await form._loadPromise
    assert.equal(form.data.questionText, edited, form.data.errorText); assert.equal(form.data.adoptionId, decision.id)
    assert.equal(await form.ask(), false); assert.ok(form.data.pendingId)
    assert.equal(await form.queryPending(), true, form.data.errorText)
    assert.equal(form.data.questions[0].question, edited); assert.equal(form.data.questions[0].source_ai_decision_id, decision.id)
    for (const route of ['/agent/artifact-decisions','/care/clarifications']) assert.equal(traffic.filter(row => row.url === base + route && row.method === 'POST').length, 1)
    require('../utils/session-privacy').replacePatientSession({ access_token: owner.access_token, user: owner.user })
    assert.equal(agent.openDecision(), false); assert.equal(agent.data.adoptedDecision, null)
    guardian = h.load('review-questions', options); await guardian._loadPromise
    assert.equal(guardian.data.questions[0].question, edited, guardian.data.errorText)
    guardian.onHide(); assert.deepEqual(guardian.data.questions, [])
    fs.writeFileSync(path.join(root, 'docs/evidence/w08-artifact-question-mini-http-receipt.json'), JSON.stringify({ actual_tcp_http: true,
      actual_mini_controllers_queue_request: true, synthetic_temporary_stores: true, native_wechat_verified: false,
      actual_child_guardian: true, artifact_id: artifact.id, decision_id: decision.id, actual_question_id: form.data.questions[0].id,
      human_edit_recorded_separately_from_business: true, both_committed_lost_acks_recovered_get_only: true,
      actual_original_source_bound: true, role_switch_and_hide_clear: true, mode: 'rules', actual_external_model_called: false }, null, 2))
  } finally { for (const page of [agent,form,guardian]) page?.onUnload(); h?.restore(); server.kill()
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(path.join(root, 'docs/evidence/w08-artifact-question-mini-http-server.txt'), log) }
})
