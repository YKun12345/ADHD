const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), net = require('node:net')
const { spawn } = require('node:child_process'), { setTimeout: pause } = require('node:timers/promises')
const { createHarness } = require('./helpers/cognitive-harness')
const root = path.resolve(__dirname, '../..')
const wire = (url, method = 'GET', data, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, result => {
    let body = ''; result.on('data', value => { body += value }); result.on('end', () => { try { resolve({ statusCode: result.statusCode, data: JSON.parse(body) }) } catch (error) { reject(error) } })
  }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
})
function component(pid) {
  let definition; global.Component = value => { definition = value }
  const file = require.resolve('../components/agent-actions/index'); delete require.cache[file]; require(file)
  const view = { ...definition.methods, data: { ...structuredClone(definition.data), patientId: pid }, setData(values) { Object.assign(this.data, values) } }
  return { view, definition }
}
test('actual unified next actions open real mini review and assessment pages and reject a changed source or actor', { timeout: 150000 }, async () => {
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
    h = createHarness(); h.restore(); Object.assign(h.storage, { current_user: doctor.user, access_token: doctor.access_token, api_base_url: base })
    delete require.cache[require.resolve('../utils/request')]
    wx.request = options => wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header)
      .then(result => options.success(result)).catch(error => options.fail({ errMsg: error.message }))
    const navigation = []; wx.navigateTo = options => navigation.push(options.url)
    const doc = component(0); await doc.definition.lifetimes.attached.call(doc.view)
    const action = doc.view.data.items.find(row => row.kind === 'review_assessment')
    assert.ok(action, doc.view.data.errorText)
    assert.equal(await doc.view.openAction({ currentTarget: { dataset: { id: action.id } } }), true, doc.view.data.errorText)
    assert.equal(navigation.at(-1), `/pages/doctor-review/index?patient_id=${assessment.patient_id}&assessment_id=${assessment.id}`)
    const options = { query: { patient_id: String(assessment.patient_id), assessment_id: String(assessment.id) } }
    const review = h.load('doctor-review', options); await review._loadPromise
    assert.equal(review.data.submissions[0].quality_status, 'limited', review.data.errorText); review.onUnload()
    await api(`/agent/actions/${action.id}/resolve`, incoming, { patient_id: assessment.patient_id, expected_action_digest: action.action_digest }, 403)
    require('../utils/session-privacy').replacePatientSession({ access_token: owner.access_token, user: owner.user })
    const beforeSwitch = navigation.length
    assert.equal(await doc.view.openAction({ currentTarget: { dataset: { id: action.id } } }), false)
    assert.equal(navigation.length, beforeSwitch); assert.deepEqual(doc.view.data.items, [])
    const patient = component(assessment.patient_id); await patient.definition.lifetimes.attached.call(patient.view)
    const next = patient.view.data.items.find(row => row.kind === 'continue_assessment')
    assert.ok(next, patient.view.data.errorText)
    assert.equal(patient.view.data.items.some(row => row.target.page_key === 'doctor_review'), false)
    assert.equal(await patient.view.openAction({ currentTarget: { dataset: { id: next.id } } }), true, patient.view.data.errorText)
    const page = h.load('assessments', options); await page._loadPromise
    assert.equal(page.data.assessment.id, assessment.id, page.data.errorText)
    const item = page.data.itemViews.find(row => row.kind === 'scale' && row.canAttempt)
    page.setRespondentConfirmation({ detail: { value: ['confirmed'] } })
    assert.equal(await page.createAttempt({ currentTarget: { dataset: { id: item.id } } }), true, page.data.errorText)
    const beforeStale = navigation.length
    assert.equal(await patient.view.openAction({ currentTarget: { dataset: { id: next.id } } }), false)
    assert.equal(navigation.length, beforeStale); assert.deepEqual(patient.view.data.items, [])
    assert.equal(await patient.view.reload(), true, patient.view.data.errorText)
    const refreshed = patient.view.data.items.find(row => row.kind === 'continue_assessment'); assert.notEqual(refreshed.id, next.id)
    patient.definition.pageLifetimes.hide.call(patient.view); assert.deepEqual(patient.view.data.items, [])
    fs.writeFileSync(path.join(root, 'docs/evidence/w08-agent-actions-mini-http-receipt.json'), JSON.stringify({ actual_tcp_http: true,
      actual_mini_component_and_business_controllers: true, synthetic_temporary_stores: true, native_wechat_verified: false,
      verified_child_guardian: true, doctor_action_id: action.id, original_patient_action_id: next.id, refreshed_patient_action_id: refreshed.id,
      actual_review_opened: true, actual_assessment_opened: true, changed_source_rejected: true, changed_actor_rejected: true,
      mode: 'rules', model_run_verified: false }, null, 2))
  } finally { h?.restore(); server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(path.join(root, 'docs/evidence/w08-agent-actions-mini-http-server.txt'), log) }
})
