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
test('actual mini child plan publication, receipt, real daily record, future revision and suspension stay separate', { timeout: 180000 }, async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', h; server.stdout.on('data', value => { log += value }); server.stderr.on('data', value => { log += value })
  async function api(route, auth, body, expected = 200) {
    const result = await wire(base + route, body === undefined ? 'GET' : 'POST', body, { ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
      ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w06-local-synthetic-only' } : {}) })
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(result.statusCode), JSON.stringify(result)); return result.data
  }
  try {
    for (let n = 0; n < 300; n++) { if (server.exitCode !== null) throw new Error(log)
      try { if ((await wire(base + '/care/assessment-templates')).statusCode === 401) break } catch (_) {}
      if (n === 299) throw new Error('Synthetic startup timeout'); await pause(100) }
    const { owner, doctor, assessment } = await api('/__synthetic__/review-source', null, { child: true })
    const context = await api(`/care/assessments/${assessment.id}/review-context`, doctor)
    const draft = await api('/care/reviews', doctor, { client_review_id: 'plan-source-draft', patient_id: assessment.patient_id,
      assessment_id: assessment.id, expected_assessment_version: context.assessment_version, input_digest: context.input_digest,
      review_context: context.review_context, category: 'evidence_review', body: '实际医生核对合成材料，安排真实日期记录并继续核对。', limitations: '演示资料，材料有限，不能作诊断。',
      decisions: context.submissions.map(row => ({ submission_id: row.submission_id, assessment_item_id: row.assessment_item_id,
        attempt_id: row.attempt_id, decision: 'needs_repeat', reason: '实际中断，需要复核。' })), confirmed: true }, 201)
    const publishing = await api(`/care/reviews/${draft.id}/publication-context`, doctor)
    await api('/care/review-publications', doctor, { client_publication_id: 'plan-source-publication', patient_id: assessment.patient_id,
      assessment_id: assessment.id, review_id: draft.id, expected_assessment_version: publishing.expected_assessment_version,
      expected_previous_report_version: publishing.expected_previous_report_version, input_digest: draft.input_digest,
      publication_context: publishing.publication_context, confirmed: true }, 201)
    h = createHarness(); h.restore(); Object.assign(h.storage, { current_user: doctor.user, access_token: doctor.access_token, api_base_url: base })
    delete require.cache[require.resolve('../utils/request')]
    let lostPublication = true, lostReceipt = true, posts = 0
    wx.showModal = options => options.success({ confirm: true })
    wx.request = options => wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header).then(result => {
      if (options.method === 'POST') posts++
      if (result.statusCode === 201 && ((options.url.endsWith('/care/plan-versions') && lostPublication) || (options.url.endsWith('/care/plan-acknowledgements') && lostReceipt))) {
        if (options.url.endsWith('/care/plan-versions')) lostPublication = false; else lostReceipt = false
        options.fail({ errMsg: 'synthetic response lost after actual plan commit' })
      } else options.success(result)
    }).catch(error => options.fail({ errMsg: error.message }))
    const options = { query: { patient_id: String(assessment.patient_id), assessment_id: String(assessment.id) } }
    const publisher = h.load('doctor-plan', options); await publisher._loadPromise
    assert.equal(publisher.data.canPublish, true, publisher.data.errorText)
    publisher.onTextInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '合成儿童真实记录安排' } })
    publisher.onTextInput({ currentTarget: { dataset: { field: 'instructions' } }, detail: { value: '由当前获准监护人按实际情况记录，每日缺失保持为空。' } })
    assert.equal(await publisher.publish(), false, publisher.data.errorText); assert.equal(posts, 1)
    assert.equal(require('../utils/submission-queue').pendingEntries()[0].kind, 'plan_publication')
    publisher.onHide(); await publisher.onShow(); assert.equal(await publisher.queryPending(), true, publisher.data.errorText)
    assert.equal(posts, 1); const first = publisher.data.versions[0]; publisher.onUnload()
    const privacy = require('../utils/session-privacy'); privacy.replacePatientSession({ access_token: owner.access_token, user: owner.user })
    const reader = h.load('patient-plan', options); await reader._loadPromise
    assert.equal(reader.data.canReceive, true, reader.data.errorText)
    assert.equal(reader.data.tasks.some(task => task.status === 'completed'), false)
    assert.equal(await reader.receive(), false, reader.data.errorText); assert.equal(posts, 2)
    reader.onHide(); await reader.onShow(); assert.equal(await reader.queryPending(), true, reader.data.errorText)
    assert.equal(posts, 2); assert.equal(reader.data.canReceive, false)
    assert.equal(reader.data.tasks.some(task => task.status === 'completed'), false)
    assert.equal(reader.data.plan.acknowledgements[0].meaning, 'received_only')
    const cycle = h.load('care-cycles', { query: { patient_id: String(assessment.patient_id), cycle_id: String(first.cycle_id) } }); await cycle._loadPromise
    assert.equal(cycle.data.cycle.id, first.cycle_id, cycle.data.errorText); assert.equal(cycle.data.canRecord, true)
    cycle.setData({ note: '实际监护人提交的合成当日观察' })
    assert.equal(await cycle.saveDaily(), true, cycle.data.errorText); assert.equal(posts, 3)
    const actualRecord = cycle.data.records[0]; assert.equal(actualRecord.actor_user_id, owner.user.id); assert.equal(actualRecord.recorded_at, null)
    cycle.onHide(); reader.onUnload(); privacy.replacePatientSession({ access_token: doctor.access_token, user: doctor.user })
    const reviser = h.load('doctor-plan', options); await reviser._loadPromise
    assert.equal(await reviser.openCycle({ currentTarget: { dataset: { id: first.cycle_id } } }), true, reviser.data.errorText)
    assert.equal(reviser.data.records[0].record_id, actualRecord.record_id)
    reviser.onTextInput({ currentTarget: { dataset: { field: 'instructions' } }, detail: { value: '医生明确修订未来安排，保持过去记录原版本。' } })
    assert.equal(await reviser.publish(), true, reviser.data.errorText); assert.equal(posts, 4)
    assert.equal(reviser.data.versions.length, 2)
    const second = reviser.data.versions[1]; assert.notEqual(second.cycle_id, first.cycle_id)
    assert.equal(reviser.data.tasks.find(task => task.daily_record_id === actualRecord.record_id).status, 'completed')
    assert.ok(reviser.data.tasks.some(task => task.plan_version_id === first.id && task.status === 'superseded_future'))
    reviser.onUnload(); privacy.replacePatientSession({ access_token: owner.access_token, user: owner.user })
    const relation = (await api('/care/relationships', owner)).items.find(row => row.doctor_user_id === doctor.user.id)
    await api(`/care/relationships/${relation.id}/revoke`, owner, { expected_revision: relation.revision })
    const suspended = h.load('patient-plan', options); await suspended._loadPromise
    assert.equal(suspended.data.plan.status, 'suspended', suspended.data.errorText)
    assert.equal(suspended.data.canReceive, false)
    assert.equal(suspended.data.tasks.find(task => task.daily_record_id === actualRecord.record_id).status, 'completed')
    const originalAck = await api(`/care/daily-records/${actualRecord.client_submission_id}`, owner)
    assert.equal(originalAck.record_id, actualRecord.record_id)
    suspended.onHide(); assert.equal(suspended.data.plan, null); assert.deepEqual(suspended.data.tasks, [])
    fs.writeFileSync(path.join(root, 'docs/evidence/w06-plan-mini-http-receipt.json'), JSON.stringify({ actual_tcp_http: true,
      actual_mini_controllers_and_queue: true, verified_child_guardian: true, synthetic_temporary_stores: true, native_wechat_verified: false,
      plan_id: first.plan_id, first_version_id: first.id, second_version_id: second.id, first_cycle_id: first.cycle_id,
      second_cycle_id: second.cycle_id, actual_daily_record_id: actualRecord.record_id, actual_guardian_id: owner.user.id,
      actual_doctor_id: doctor.user.id, post_count: posts, lost_ack_recovery_get_only: true,
      receipt_did_not_complete_tasks: true, future_revision_preserved_actual_record: true, withdrawal_suspended_plan: true }, null, 2))
  } finally { h?.restore(); server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(path.join(root, 'docs/evidence/w06-plan-mini-http-server.txt'), log) }
})
