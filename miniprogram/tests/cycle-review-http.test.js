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
test('actual mini stage review recovers lost ACK and opens, explicitly publishes and executes a real independent next assessment', { timeout: 160000 }, async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', h, stage, next, patient, doctorPlan; const traffic = [], navigation = []; let loseAck = true
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
    const { owner, doctor, assessment, plan } = await api('/__synthetic__/review-source', null, { cycle_review: true })
    const oldDaily = await api('/care/daily-records/cycle-actual-day', owner)
    h = createHarness(); h.restore(); Object.assign(h.storage, { current_user: doctor.user, access_token: doctor.access_token, api_base_url: base })
    delete require.cache[require.resolve('../utils/request')]
    wx.request = async options => {
      try {
        traffic.push({ method: options.method, url: options.url })
        const result = await wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header)
        if (loseAck && options.url === `${base}/care/cycle-reviews` && options.method === 'POST' && result.statusCode === 201) {
          loseAck = false; options.fail({ errMsg: 'synthetic lost response after committed stage decision' }); return
        }
        options.success(result)
      } catch (error) { options.fail({ errMsg: error.message }) }
    }
    wx.navigateTo = options => navigation.push(options.url); wx.showModal = options => options.success({ confirm: true })
    doctorPlan = h.load('doctor-plan', { query: { patient_id: String(assessment.patient_id), assessment_id: String(assessment.id) } }); await doctorPlan._loadPromise
    assert.equal(doctorPlan.openStageReview({ currentTarget: { dataset: { id: plan.cycle_id } } }), true)
    assert.equal(navigation.at(-1), `/pages/cycle-review/index?patient_id=${assessment.patient_id}&cycle_id=${plan.cycle_id}`)
    stage = h.load('cycle-review', { query: { patient_id: String(assessment.patient_id), cycle_id: String(plan.cycle_id) } }); await stage._loadPromise
    assert.equal(stage.data.canConfirm, true, stage.data.errorText); assert.ok(stage.data.coverageText.includes('1 / 1'))
    assert.equal(stage.data.records[0].focusText, '未记录')
    stage.selectDecision({ detail: { value: String(stage.data.decisions.findIndex(row => row.value === 'next_round')) } })
    for (const [field,value] of Object.entries({ body: '核对实际阶段材料后另建下一轮。', limitations: '合成材料有局限，不判定疗效。', reason: '继续核对实际证据。' })) {
      stage.onField({ currentTarget: { dataset: { field } }, detail: { value } })
    }
    assert.equal(await stage.confirmReview(), false); assert.ok(stage.data.pendingId)
    const originalId = stage.data.pendingId
    assert.equal(await stage.queryPending(), true, stage.data.errorText); assert.equal(stage.data.canConfirm, false)
    const review = stage.data.reviews[0]; assert.ok(review.next_assessment_id); assert.equal(review.decision, 'next_round')
    assert.equal(review.input_snapshot.record_revisions[0].record_id, oldDaily.record_id)
    assert.equal(traffic.filter(row => row.method === 'POST' && row.url === `${base}/care/cycle-reviews`).length, 1)
    assert.ok(traffic.some(row => row.method === 'GET' && row.url.endsWith('/cycle-reviews/submissions/' + originalId)))
    await api(`/care/assessments/${review.next_assessment_id}`, owner, undefined, 403)
    assert.equal(stage.openNext({ currentTarget: { dataset: { id: review.id } } }), true)
    next = h.load('assessments', { query: { patient_id: String(assessment.patient_id), assessment_id: String(review.next_assessment_id) } }); await next._loadPromise
    assert.equal(next.data.assessment.id, review.next_assessment_id, next.data.errorText); assert.equal(next.data.assessment.canPublish, true)
    assert.equal(await next.publishAssessment(), true, next.data.errorText)
    require('../utils/session-privacy').replacePatientSession({ access_token: owner.access_token, user: owner.user })
    assert.equal(stage.openNext({ currentTarget: { dataset: { id: review.id } } }), false); assert.deepEqual(stage.data.reviews, [])
    patient = h.load('assessments', { query: { patient_id: String(assessment.patient_id), assessment_id: String(review.next_assessment_id) } }); await patient._loadPromise
    assert.equal(patient.data.assessment.previous_assessment_id, assessment.id, patient.data.errorText)
    const scale = patient.data.itemViews.find(row => row.kind === 'scale' && row.canAttempt)
    patient.setRespondentConfirmation({ detail: { value: ['confirmed'] } })
    assert.equal(await patient.createAttempt({ currentTarget: { dataset: { id: scale.id } } }), true, patient.data.errorText)
    assert.equal((await api('/care/daily-records/cycle-actual-day', owner)).cycle_id, plan.cycle_id)
    assert.deepEqual(await api('/care/daily-records/cycle-actual-day', owner), oldDaily)
    fs.writeFileSync(path.join(root, 'docs/evidence/w06-cycle-review-mini-http-receipt.json'), JSON.stringify({
      actual_tcp_http: true, actual_mini_controllers_queue_request: true, synthetic_temporary_stores: true, native_wechat_verified: false,
      source_cycle_id: plan.cycle_id, stage_review_id: review.id, next_assessment_id: review.next_assessment_id,
      committed_lost_ack_recovered_get_only: true, next_round_requires_separate_explicit_publication: true,
      user_starts_actual_new_task: true, original_daily_ack_unchanged: true, actor_switch_clears: true
    }, null, 2))
  } finally { for (const page of [stage,next,patient,doctorPlan]) page?.onUnload(); h?.restore(); server.kill()
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(path.join(root, 'docs/evidence/w06-cycle-review-mini-http-server.txt'), log) }
})
