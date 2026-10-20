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
test('actual mini doctor question and verified guardian answer recover both lost ACKs and enter the next frozen review', { timeout: 150000 }, async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', h; server.stdout.on('data', value => { log += value }); server.stderr.on('data', value => { log += value })
  async function api(route, auth, body, expected = 200) {
    const response = await wire(base + route, body === undefined ? 'GET' : 'POST', body, { ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
      ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w06-local-synthetic-only' } : {}) })
    assert.equal(response.statusCode, expected, JSON.stringify(response.data)); return response.data
  }
  try {
    for (let n = 0; n < 300; n++) { if (server.exitCode !== null) throw new Error(log)
      try { if ((await wire(base + '/care/assessment-templates')).statusCode === 401) break } catch (_) {}
      if (n === 299) throw new Error('Synthetic startup timeout'); await pause(100) }
    const { owner, doctor, incoming, assessment } = await api('/__synthetic__/review-source', null, { child: true })
    const original = await api(`/care/assessments/${assessment.id}/review-context`, doctor)
    h = createHarness(); h.restore(); Object.assign(h.storage, { current_user: doctor.user, access_token: doctor.access_token, api_base_url: base })
    delete require.cache[require.resolve('../utils/request')]
    let lostQuestion = true, lostReply = true, posts = 0
    wx.showModal = options => options.success({ confirm: true })
    wx.request = options => wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header).then(response => {
      if (options.method === 'POST') posts++
      if (response.statusCode === 201 && ((options.url.endsWith('/care/clarifications') && lostQuestion) || (options.url.endsWith('/care/clarification-replies') && lostReply))) {
        if (options.url.endsWith('/care/clarifications')) lostQuestion = false; else lostReply = false
        options.fail({ errMsg: 'synthetic response lost after actual clarification commit' })
      } else options.success(response)
    }).catch(error => options.fail({ errMsg: error.message }))
    const options = { query: { patient_id: String(assessment.patient_id), assessment_id: String(assessment.id) } }
    const ask = h.load('review-questions', options); await ask._loadPromise
    assert.equal(ask.data.sources[0].source_type, 'submission', ask.data.errorText)
    ask.onQuestionInput({ detail: { value: '请核对这次中断的实际原因；可以回答不知道或跳过。' } })
    assert.equal(await ask.ask(), false, ask.data.errorText)
    assert.equal(require('../utils/submission-queue').pendingEntries()[0].kind, 'review_question'); assert.equal(posts, 1)
    ask.onHide(); await ask.onShow(); assert.equal(await ask.queryPending(), true, ask.data.errorText)
    assert.equal(posts, 1); const question = ask.data.questions[0]; assert.equal(question.actor_user_id, doctor.user.id)
    ask.onUnload()
    require('../utils/session-privacy').replacePatientSession({ access_token: owner.access_token, user: owner.user })
    const answer = h.load('review-questions', options); await answer._loadPromise
    assert.equal(await answer.selectQuestion({ currentTarget: { dataset: { id: question.id } } }), true, answer.data.errorText)
    assert.equal(await answer.answer(), false, answer.data.errorText); assert.equal(posts, 2)
    const queued = require('../utils/submission-queue').pendingEntries()[0]; assert.equal(queued.kind, 'clarification_reply')
    assert.equal(queued.payload.answer_status, 'unknown'); assert.equal(queued.payload.answer, null)
    answer.onHide(); await answer.onShow(); assert.equal(await answer.queryPending(), true, answer.data.errorText)
    const saved = answer.data.questions[0].replies[0]
    assert.equal(saved.actor_user_id, owner.user.id); assert.equal(saved.answer_status, 'unknown'); assert.equal(saved.answer, null); assert.equal(posts, 2)
    answer.onHide(); assert.deepEqual(answer.data.questions, []); assert.equal(answer.data.answerText, '')
    await api(`/care/assessments/${assessment.id}/clarifications`, incoming, undefined, 403)
    const next = await api(`/care/assessments/${assessment.id}/review-context`, doctor)
    assert.notEqual(next.input_digest, original.input_digest); assert.equal(next.clarifications[0].replies[0].id, saved.id)
    fs.writeFileSync(path.join(root, 'docs/evidence/w06-clarification-mini-http-receipt.json'), JSON.stringify({ actual_tcp_http: true,
      actual_mini_controller_and_queue: true, synthetic_temporary_stores: true, native_wechat_verified: false, verified_child: true,
      actual_doctor_id: doctor.user.id, actual_guardian_id: owner.user.id, question_id: question.id, reply_id: saved.id,
      reply_revision: saved.revision, answer_status: saved.answer_status, answer: saved.answer, post_count: posts,
      lost_ack_recovery_get_only: true, next_frozen_review_contains_actual_reply: true }, null, 2))
  } finally { h?.restore(); server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(path.join(root, 'docs/evidence/w06-clarification-mini-http-server.txt'), log) }
})
