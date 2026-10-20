const { test } = require('node:test'), assert = require('node:assert/strict')
const path = require('node:path'), http = require('node:http'), net = require('node:net')
const { spawn } = require('node:child_process'), { setTimeout: pause } = require('node:timers/promises')
const { createHarness } = require('./helpers/cognitive-harness')
const root = path.resolve(__dirname, '../..')
const wire = (url, method = 'GET', data, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, response => {
    let body = ''; response.on('data', value => { body += value }); response.on('end', () => { try { resolve({ statusCode: response.statusCode, data: JSON.parse(body) }) } catch (error) { reject(error) } })
  }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
})

test('actual mini profile and cycle suggestions require human review then reach separate business confirmations', { timeout: 150000 }, async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port
  await new Promise(resolve => probe.close(resolve)); const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false', AGENT_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', harness, chat, assessment, review
  server.stdout.on('data', value => { log += value }); server.stderr.on('data', value => { log += value })
  const api = async (route, auth, data, status = 200) => {
    const response = await wire(base + route, data === undefined ? 'GET' : 'POST', data, { ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
      ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w06-local-synthetic-only' } : {}) })
    assert.equal(response.statusCode, status, JSON.stringify(response.data)); return response.data
  }
  const completed = async () => {
    for (let n = 0; n < 100; n++) { const row = chat.data.runs.at(-1); if (row && !['queued','running'].includes(row.status)) return row
      clearTimeout(chat._pollTimer); await chat.refreshRun(); await pause(80) }
    throw Error('Synthetic background timeout: ' + chat.data.errorText)
  }
  try {
    for (let n = 0; n < 300; n++) { if (server.exitCode !== null) throw Error(log)
      try { if ((await wire(base + '/care/assessment-templates')).statusCode === 401) break } catch (_) {}
      if (n === 299) throw Error('Synthetic startup timeout'); await pause(100) }
    const source = await api('/__synthetic__/review-source', null, { child: false }), owner = source.owner, pid = source.assessment.patient_id
    harness = createHarness(); harness.restore(); Object.assign(harness.storage, { current_user: owner.user, access_token: owner.access_token, api_base_url: base })
    delete require.cache[require.resolve('../utils/request')]
    wx.showModal = options => options.success({ confirm: true })
    wx.request = async options => { try { options.success(await wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header)) } catch (error) { options.fail({ errMsg: error.message }) } }
    chat = harness.load('agent-chat', { query: { patient_id: String(pid) } }); await chat._loadPromise
    chat.selectIntent({ detail: { value: String(chat.data.intents.findIndex(row => row.value === 'profile_fields')) } })
    chat.onProfileField({ currentTarget: { dataset: { scope: 'input', index: 3, type: 'status' } }, detail: { value: 'provided' } })
    chat.onProfileField({ currentTarget: { dataset: { scope: 'input', index: 3, type: 'value' } }, detail: { value: '本人主动提供的合成睡眠说明' } })
    assert.equal(await chat.send(), true, chat.data.errorText); const background = await completed()
    await chat.openEditor({ currentTarget: { dataset: { id: background.artifact.id } } })
    chat.onEditorInput({ currentTarget: { dataset: { field: 'editorReason' } }, detail: { value: '本人逐项核对背景原文和未知状态。' } })
    assert.equal(await chat.saveEditor({ currentTarget: { dataset: { action: 'use' } } }), false)
    for (let index = 0; index < chat.data.editorFields.length; index++) chat.onProfileField({ currentTarget: { dataset: { scope: 'editor', index, type: 'confirmed' } }, detail: { value: ['confirmed'] } })
    assert.equal(await chat.saveEditor({ currentTarget: { dataset: { action: 'use' } } }), true, chat.data.errorText)
    const adopted = chat.data.adoptedDecision; assert.equal(adopted.target_type, 'assessment_background')
    assessment = harness.load('assessments', { query: { patient_id: String(pid), ai_decision_id: String(adopted.id) } }); await assessment._loadPromise
    assert.equal(assessment.data.adoptionId, adopted.id, assessment.data.errorText)
    assert.equal(await assessment.createAssessment(), false)
    for (let index = 0; index < assessment.data.backgroundFields.length; index++) assessment.confirmBackgroundField({ currentTarget: { dataset: { index } }, detail: { value: ['confirmed'] } })
    assert.equal(await assessment.createAssessment(), true, assessment.data.errorText)
    assert.equal(assessment.data.assessment.source_ai_decision_id, adopted.id)
    const savedBackground = assessment.data.assessment.background
    assert.equal(savedBackground.sleep.value, '本人主动提供的合成睡眠说明'); assert.equal(savedBackground.medication.value, null)
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }), start = new Date(Date.parse(day + 'T00:00:00Z') - 13 * 86400000).toISOString().slice(0,10)
    const cycle = await api('/care/cycles', owner, { patient_id: pid, client_cycle_id: 'mini-adoption-cycle', start_date: start, end_date: day }, 201)
    const original = await api('/care/daily-records', owner, { patient_id: pid, cycle_id: cycle.id, record_date: day, client_submission_id: 'mini-adoption-day', expected_revision: 0, content: { note: '实际合成原件' }, recorded_at: null }, 201)
    await chat.reload(); chat.selectIntent({ detail: { value: String(chat.data.intents.findIndex(row => row.value === 'cycle_summary')) } }); chat.onInput({ detail: { value: '请整理这个实际周期。' } })
    assert.equal(await chat.send(), true, chat.data.errorText); const summary = await completed()
    await chat.openEditor({ currentTarget: { dataset: { id: summary.artifact.id } } }); chat.onEditorInput({ currentTarget: { dataset: { field: 'editorReason' } }, detail: { value: '本人核对周期来源和覆盖。' } })
    assert.equal(await chat.saveEditor({ currentTarget: { dataset: { action: 'use' } } }), true, chat.data.errorText)
    const chosen = chat.data.adoptedDecision; assert.equal(chosen.cycle_id, cycle.id)
    review = harness.load('cycle-review', { query: { patient_id: String(pid), cycle_id: String(cycle.id), ai_decision_id: String(chosen.id) } }); await review._loadPromise
    assert.equal(review.data.adoptionId, chosen.id, review.data.errorText)
    review.onField({ currentTarget: { dataset: { field: 'limitations' } }, detail: { value: '只是覆盖汇总，未知不补造。' } }); review.onField({ currentTarget: { dataset: { field: 'reason' } }, detail: { value: '本人明确结束这一周期。' } })
    assert.equal(await review.confirmReview(), true, review.data.errorText)
    assert.equal(review.data.reviews[0].source_ai_decision_id, chosen.id); assert.equal(review.data.reviews[0].professional_confirmation, false)
    assert.deepEqual(await api('/care/daily-records/mini-adoption-day', owner), original)
  } finally {
    chat?.onUnload(); assessment?.onUnload(); review?.onUnload(); harness?.restore(); server.kill()
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
  }
})
