// Real mini controllers + durable queue + TCP HTTP. TestClient provisions genuine
// synthetic W03/W04 sources in a separate temporary server store; no fake ACKs.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), http = require('node:http')
const { spawn } = require('node:child_process'), { setTimeout: pause } = require('node:timers/promises')
const { createHarness } = require('./helpers/cognitive-harness')
const root = path.resolve(__dirname, '../..')
const wire = (url, method = 'GET', data, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, response => {
    let body = ''; response.on('data', value => { body += value }); response.on('end', () => { try { resolve({ statusCode: response.statusCode, data: JSON.parse(body) }) } catch (failure) { reject(failure) } })
  }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
})
test('actual doctor review and published-version mini flow handles both lost ACKs, lawful owner reading and child authorship', { timeout: 180000 }, async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', h; const observations = []
  server.stdout.on('data', value => { log += value }); server.stderr.on('data', value => { log += value })
  const api = async (route, auth, data, expected = 200) => {
    const response = await wire(base + route, data === undefined ? 'GET' : 'POST', data,
      { ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}), ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w06-local-synthetic-only' } : {}) })
    assert.equal(response.statusCode, expected, JSON.stringify(response.data)); return response.data
  }
  try {
    for (let n = 0; n < 300; n++) { if (server.exitCode !== null) throw new Error(log)
      try { if ((await wire(base + '/care/assessment-templates')).statusCode === 401) break } catch (_) {}
      if (n === 299) throw new Error('Synthetic server startup timeout'); await pause(100)
    }
    for (const child of [false, true]) {
      const fixture = await api('/__synthetic__/review-source', null, { child })
      const { doctor, owner, incoming, assessment } = fixture, pid = assessment.patient_id
      h = createHarness(); h.restore(); Object.assign(h.storage, { current_user: doctor.user, access_token: doctor.access_token, api_base_url: base })
      delete require.cache[require.resolve('../utils/request')]
      let lostDraft = true, lostPublication = true, posts = 0
      wx.showModal = options => options.success({ confirm: true })
      wx.request = options => {
        wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header).then(response => {
          if (options.method === 'POST') posts++
          if (response.statusCode === 201 && options.method === 'POST' && ((options.url.endsWith('/care/reviews') && lostDraft) || (options.url.endsWith('/care/review-publications') && lostPublication))) {
            if (options.url.endsWith('/care/reviews')) lostDraft = false; else lostPublication = false
            options.fail({ errMsg: 'synthetic response lost after actual database commit' })
          } else options.success(response)
        }).catch(failure => options.fail({ errMsg: failure.message }))
      }
      const page = h.load('doctor-review', { query: { patient_id: String(pid), assessment_id: String(assessment.id) } }); await page._loadPromise
      assert.equal(page.data.submissions[0].quality_status, 'limited')
      if (child) assert.equal(page.data.attempts[0].performer_patient_id, pid)
      const row = page.data.submissions[0]
      page.onDecisionChange({ currentTarget: { dataset: { id: row.submission_id } }, detail: { value: 'needs_repeat' } })
      page.onDecisionReason({ currentTarget: { dataset: { id: row.submission_id } }, detail: { value: '实际试次有中断，须保留局限并安排新尝试。' } })
      page.onFieldInput({ currentTarget: { dataset: { field: 'body' } }, detail: { value: '合成实际医生已核对原件，本次仅发布材料审核。' } })
      page.onFieldInput({ currentTarget: { dataset: { field: 'limitations' } }, detail: { value: '演示资料及其他未完成材料，不能作临床诊断。' } })
      assert.equal(await page.saveDraft(), false, page.data.errorText)
      const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
      assert.equal(original.kind, 'review_draft'); assert.equal(posts, 1)
      page.onHide(); await page.onShow(); assert.equal(await page.queryPending(), true, page.data.errorText)
      assert.equal(posts, 1); assert.equal(page.data.drafts.length, 1)
      const draft = page.data.drafts[0]
      assert.equal(await page.openDraft({ currentTarget: { dataset: { id: draft.id } } }), true)
      assert.equal(await page.publish(), false, page.data.errorText)
      const publication = q.pendingEntries()[0]
      assert.equal(publication.kind, 'review_publication'); assert.equal(posts, 2)
      assert.equal(await page.queryPending(), true, page.data.errorText); assert.equal(posts, 2)
      assert.equal(page.data.reports.length, 1); const report = page.data.reports[0]
      assert.equal(report.actor_user_id, doctor.user.id); assert.equal(report.version, 1)
      await api(`/care/reports/${report.id}`, incoming, undefined, 403)
      page.onUnload()
      require('../utils/session-privacy').replacePatientSession({ access_token: owner.access_token, user: owner.user })
      const read = h.load('care-reports', { query: { patient_id: String(pid), assessment_id: String(assessment.id) } }); await read._loadPromise
      assert.equal(read.data.reports.length, 1)
      assert.equal(await read.openReport({ currentTarget: { dataset: { id: report.id } } }), true, read.data.errorText)
      assert.equal(read.data.report.body, draft.body)
      assert.match(read.data.inputText, /limited/)
      const actual = await api(`/care/assessments/${assessment.id}`, owner)
      assert.notEqual(actual.status, 'reviewed')
      assert.equal(actual.items.find(item => item.id === row.assessment_item_id).acceptance_status, 'needs_repeat')
      read.onHide(); assert.equal(read.data.report, null); assert.equal(read.data.inputText, '')
      const repeat = h.load('assessments', { query: { patient_id: String(pid), assessment_id: String(assessment.id) } }); await repeat._loadPromise
      assert.equal(repeat.data.assessment.id, assessment.id, repeat.data.errorText)
      const selected = repeat.data.itemViews.find(item => item.id === row.assessment_item_id)
      assert.equal(selected.repeat_request.report_id, report.id); assert.equal(selected.canAttempt, true)
      repeat.setRespondentConfirmation({ detail: { value: ['confirmed'] } })
      assert.equal(await repeat.createAttempt({ currentTarget: { dataset: { id: row.assessment_item_id } } }), true, repeat.data.errorText)
      assert.equal(posts, 3)
      const newAttempt = repeat.data.itemViews.find(item => item.id === row.assessment_item_id).attempts.at(-1)
      assert.equal(newAttempt.metadata.repeat_request.report_id, report.id)
      assert.notEqual(newAttempt.id, row.attempt_id)
      assert.equal(repeat.resumeAttempt({ currentTarget: { dataset: { id: row.assessment_item_id } } }), true)
      const execution = require('../utils/assessment-execution')
      const context = await execution.loadExecution({ assessment_id: String(assessment.id), item_id: String(row.assessment_item_id), attempt_id: String(newAttempt.id) }, selected.instrument)
      assert.equal(context.attempt.id, newAttempt.id); execution.beginExecution(context)
      assert.equal(execution.buildSubmission(context, {}).attempt_id, newAttempt.id)
      assert.equal(posts, 3); repeat.onHide()
      observations.push({ child, actual_patient_id: pid, actual_doctor_id: doctor.user.id, original_actor_id: row.actor_user_id,
        original_draft_id: original.id, original_publication_id: publication.id, report_id: report.id, report_version: 1,
        review_post_count: 2, repeat_start_post_count: 1, post_count: posts, actual_repeat_attempt_id: newAttempt.id,
        real_repeat_source_bound: true, repeat_formal_execution_entered: true, repeat_resume_get_only: true, lost_ack_recovery_get_only: true,
        source_provisioning: 'production_api_testclient', private_draft_not_accepted: true })
      h.restore(); h = null
    }
    fs.writeFileSync(path.join(root, 'docs/evidence/w06-review-mini-http-receipt.json'), JSON.stringify({ actual_tcp_http: true,
      actual_mini_controllers_and_queue: true, synthetic_temporary_stores: true, native_wechat_verified: false, observations }, null, 2))
  } finally { h?.restore(); server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(path.join(root, 'docs/evidence/w06-review-mini-http-server.txt'), log) }
})
