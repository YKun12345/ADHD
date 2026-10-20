const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), net = require('node:net')
const { spawn } = require('node:child_process'), { setTimeout: pause } = require('node:timers/promises')
const { createHarness } = require('./helpers/cognitive-harness')
const root = path.resolve(__dirname, '../..')
const evidenceTag = process.env.W08_ARTIFACT_EVIDENCE_TAG || 'initial'
if (!/^[A-Za-z0-9_-]+$/.test(evidenceTag)) throw new Error('Invalid synthetic evidence tag')
const evidenceStem = `w08-artifact-business-mini-http-${evidenceTag}`
const step = name => console.log(`verified_stage:${name}`)
const wire = (url, method = 'GET', data, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, response => {
    let body = ''; response.on('data', value => { body += value }); response.on('end', () => { try { resolve({ statusCode: response.statusCode, data: JSON.parse(body) }) } catch (error) { reject(error) } })
  }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
})
test('actual mini edited summary, plan and reply each reach a separate confirmed business form with original AI provenance', { timeout: 360000 }, async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', h, activeAgent; const pages = [], navigation = [], observations = []
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
    const { owner, doctor, assessment } = await api('/__synthetic__/review-source', null, { child: true }); step('synthetic_source_ready')
    h = createHarness(); h.restore(); Object.assign(h.storage, { current_user: doctor.user, access_token: doctor.access_token, api_base_url: base })
    delete require.cache[require.resolve('../utils/request')]
    wx.request = options => wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header)
      .then(result => options.success(result)).catch(error => options.fail({ errMsg: error.message }))
    wx.navigateTo = options => navigation.push(options.url); wx.showModal = options => options.success({ confirm: true })
    const query = { patient_id: String(assessment.patient_id), assessment_id: String(assessment.id) }
    async function draft(intent, edited) {
      activeAgent?.onUnload(); activeAgent = h.load('agent-chat', { query }); pages.push(activeAgent); await activeAgent._loadPromise
      const agent = activeAgent
      agent.selectIntent({ detail: { value: String(agent.data.intents.findIndex(row => row.value === intent)) } })
      agent.onInput({ detail: { value: '按实际原件准备草稿，待本人核对。' } }); assert.equal(await agent.send(), true, agent.data.errorText)
      const until = Date.now() + 75000
      while (['queued','running'].includes(agent.data.runs.at(-1)?.status) && Date.now() < until) { clearTimeout(agent._pollTimer); await agent.refreshRun(); await pause(80) }
      const run = agent.data.runs.at(-1); assert.equal(run.status, 'completed', JSON.stringify(run))
      assert.equal(await agent.openEditor({ currentTarget: { dataset: { id: run.artifact.id } } }), true, agent.data.errorText)
      for (const [field,value] of Object.entries({ editorText: edited, editorReason: '本人核对实际原件后编辑正文。' })) agent.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } })
      assert.equal(await agent.saveEditor({ currentTarget: { dataset: { action: 'use' } } }), true, agent.data.errorText)
      const decision = agent.data.adoptedDecision; assert.ok(decision); step(intent + '_human_decision')
      assert.equal(agent.openDecision(), true); return decision
    }
    const summary = await draft('assessment_summary','本人核对实际原件后形成材料摘要，当前执行有局限，需要后续核对。')
    assert.ok(navigation.at(-1).startsWith('/pages/doctor-review/index?'))
    const review = h.load('doctor-review', { query: { ...query, ai_decision_id: String(summary.id) } }); pages.push(review); await review._loadPromise
    assert.equal(review.data.body, summary.content.text, review.data.errorText)
    review.onFieldInput({ currentTarget: { dataset: { field: 'limitations' } }, detail: { value: '演示材料，不能用于诊断；尚有缺失和执行局限。' } })
    for (const row of review.data.submissions) {
      review.onDecisionChange({ currentTarget: { dataset: { id: row.submission_id } }, detail: { value: 'needs_repeat' } })
      review.onDecisionReason({ currentTarget: { dataset: { id: row.submission_id } }, detail: { value: '根据实际原件核对执行环境。' } })
    }
    assert.equal(await review.saveDraft(), true, review.data.errorText)
    const privateDraft = review.data.drafts.find(row => row.client_review_id === summary.target_client_id); assert.ok(privateDraft)
    assert.equal(privateDraft.source_ai_decision_id, summary.id)
    assert.equal(await review.openDraft({ currentTarget: { dataset: { id: privateDraft.id } } }), true, review.data.errorText)
    assert.equal(await review.publish(), true, review.data.errorText)
    const report = review.data.reports[0]; assert.equal(report.source_ai_decision_id, summary.id)
    assert.equal((await api(`/care/reports/${report.id}`, owner)).ai_draft_status, 'human_reviewed_source')
    step('actual_report_published'); observations.push({ kind: 'review_draft', decision_id: summary.id, actual_report_id: report.id, separate_human_publication: true })
    const plan = await draft('plan_draft','本人确认的实际日期安排：记录当日状态，缺失保持为空，不判断治疗效果。')
    assert.ok(navigation.at(-1).startsWith('/pages/doctor-plan/index?'))
    const schedule = h.load('doctor-plan', { query: { ...query, ai_decision_id: String(plan.id) } }); pages.push(schedule); await schedule._loadPromise
    assert.equal(schedule.data.instructions, plan.content.instructions, schedule.data.errorText)
    assert.equal(schedule.data.adoptionId, plan.id); assert.equal(await schedule.publish(), true, schedule.data.errorText)
    const version = schedule.data.versions.find(row => row.client_plan_version_id === plan.target_client_id)
    assert.ok(version && version.cycle_id); assert.equal(version.source_ai_decision_id, plan.id)
    step('actual_plan_and_cycle_published'); observations.push({ kind: 'plan_publication', decision_id: plan.id, actual_plan_version_id: version.id, actual_cycle_id: version.cycle_id })
    const reply = await draft('reply_draft','请说明本次记录实际遇到的困难，以便核对后续安排；不知道可以说明。')
    assert.ok(navigation.at(-1).startsWith('/pages/shared-messages/index?'))
    const messages = h.load('shared-messages', { query: { ...query, ai_decision_id: String(reply.id) } }); pages.push(messages); await messages._loadPromise
    assert.equal(messages.data.content, reply.content.text, messages.data.errorText)
    const index = messages.data.relationships.findIndex(row => row.can_send)
    assert.ok(index >= 0); assert.equal(await messages.selectRelationship({ detail: { value: String(index) } }), true, messages.data.errorText)
    assert.equal(messages.data.content, reply.content.text)
    assert.equal(await messages.sendMessage(), true, messages.data.errorText)
    const original = await api(`/care/shared-messages/submissions/${reply.target_client_id}`, doctor)
    assert.equal(original.source_ai_decision_id, reply.id); assert.equal(original.content, reply.content.text)
    const received = await api(`/care/shared-messages?patient_id=${assessment.patient_id}&relationship_id=${original.relationship_id}`, owner)
    assert.equal(received.items[0].content, reply.content.text)
    step('actual_recipient_message_sent'); observations.push({ kind: 'shared_message', decision_id: reply.id, actual_message_id: original.message_id, actual_recipient_confirmed: true })
    fs.writeFileSync(path.join(root, `docs/evidence/${evidenceStem}-receipt.json`), JSON.stringify({ actual_tcp_http: true,
      actual_mini_controllers_queue_request: true, synthetic_temporary_stores: true, actual_child_guardian: true,
      native_wechat_verified: false, mode: 'rules', actual_external_model_called: false, observations }, null, 2))
  } finally { for (const page of pages) page?.onUnload(); h?.restore(); server.kill()
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(path.join(root, `docs/evidence/${evidenceStem}-server.txt`), log) }
})
