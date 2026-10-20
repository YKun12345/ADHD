/* Current mini-program controllers -> actual isolated competition HTTP service.
 * wx storage lives only in this Node process; no WeChat installation is touched.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { setTimeout: pause } = require('node:timers/promises')
const { createHarness } = require('../../miniprogram/tests/helpers/cognitive-harness')

const root = path.resolve(__dirname, '../..')
const mainMode = process.argv.includes('--main-system')
const receiptPath = path.join(root, mainMode ? 'docs/evidence/main-system-2026-10-18/mini-http-receipt.json'
  : 'docs/evidence/competition-demo-2026-10-18/mini-http-receipt.json')
let current, runtime
if (mainMode) {
  current = { port: 8000, store_id: 'main-examples' }
  runtime = path.join(root, '.codex-tmp/main-examples')
} else {
  current = JSON.parse(fs.readFileSync(path.join(root, '.codex-tmp/competition-demo/current.json'), 'utf8'))
  assert.equal(current.synthetic, true)
  assert.equal(current.service, 'adhd-competition-demo/v1')
  assert.equal(current.port, 8770)
  runtime = path.resolve(current.runtime)
  const runtimeParent = path.join(root, '.codex-tmp/competition-demo/stores') + path.sep
  assert.ok(runtime.startsWith(runtimeParent), 'Only the current marked synthetic competition runtime is allowed.')
  const marker = JSON.parse(fs.readFileSync(path.join(runtime, 'competition-demo.json'), 'utf8'))
  assert.equal(marker.synthetic, true)
  assert.equal(marker.store_id, current.store_id)
}
const source = JSON.parse(fs.readFileSync(path.join(runtime, 'source.json'), 'utf8'))
assert.equal(source.synthetic_only, true)
assert.equal(source.external_ai_enabled, false)
if (mainMode) { assert.equal(source.main_system, true); assert.equal(source.status, 'completed') }
const origin = 'http://127.0.0.1:' + current.port
const base = origin + '/api/v1'
const traffic = [], pages = []
const receipt = {
  status: 'running', checked_at: new Date().toISOString(), store_id: current.store_id,
  service_port: current.port, main_system: mainMode, actual_tcp_http: true, actual_current_mini_controllers: true,
  actual_production_request_module: true, synthetic_only: true,
  native_wechat_verified: false, native_storage_modified: false,
  harness_storage: 'isolated Node process memory', external_ai_called: false,
  training_performed: false, checks: {}
}

function wire(url, method = 'GET', data, headers = {}) {
  const parsed = new URL(url)
  assert.equal(parsed.origin, origin, 'Every request must stay on the selected service and use synthetic accounts.')
  return new Promise((resolve, reject) => {
    const request = http.request(parsed, { method, headers: { 'Content-Type': 'application/json', ...headers } }, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        traffic.push({ method, route: parsed.pathname, status: response.statusCode })
        try { resolve({ statusCode: response.statusCode, data: JSON.parse(body) }) }
        catch (_) { reject(new Error(`${method} ${parsed.pathname}: invalid JSON response`)) }
      })
    })
    request.setTimeout(20000, () => request.destroy(new Error(`${method} ${parsed.pathname}: timeout`)))
    request.on('error', reject)
    request.end(data === undefined ? undefined : JSON.stringify(data))
  })
}

async function api(route, auth, body) {
  const response = await wire(base + route, body === undefined ? 'GET' : 'POST', body,
    auth ? { Authorization: `Bearer ${auth.access_token}` } : {})
  assert.equal(response.statusCode, 200, `${body === undefined ? 'GET' : 'POST'} ${route} returned ${response.statusCode}`)
  return response.data
}

async function main() {
  const accounts = {}
  let harness
  try {
    for (const key of ['doctor', 'review', 'followup']) {
      const original = source.accounts[key]
      accounts[key] = await api('/auth/login', null, { identifier: original.email, password: original.password, role: original.role })
      assert.equal(accounts[key].user.id, original.user.id)
      assert.equal(accounts[key].user.role, original.role)
    }
    receipt.checks.real_password_login_accounts = 3
    const reviewing = source.scenarios.review, following = source.scenarios.followup
    const ids = scenario => ({ patient_id: String(scenario.patient_id), assessment_id: String(scenario.assessment.id) })
    const event = id => ({ currentTarget: { dataset: { id } } })
    async function businessSnapshot() {
      const result = await Promise.all([
        api(`/care/assessments/${reviewing.assessment.id}`, accounts.review),
        api(`/care/assessments/${reviewing.assessment.id}/clarifications`, accounts.review),
        api(`/care/assessments/${following.assessment.id}`, accounts.followup),
        api(`/care/plans/${following.plan.id}`, accounts.followup),
        api(`/care/cycles/${following.cycle.id}`, accounts.followup),
        api(`/care/cycles/${following.historical_self_cycle.id}`, accounts.followup)
      ])
      return result
    }
    const before = await businessSnapshot()
    assert.equal(before[0].status, 'under_review')
    assert.equal(before[1].items.find(row => row.id === reviewing.clarification.id).replies.length, 0)
    harness = createHarness()
    harness.restore() // Restore real timers and clock; retain only the in-memory wx/Page host.
    delete require.cache[require.resolve('../../miniprogram/utils/request')]
    Object.assign(global.wx, {
      showToast() {}, showModal(options) { options.success({ confirm: false }) },
      getSystemInfoSync: () => ({ platform: 'node-http-harness', model: 'synthetic', windowWidth: 390, windowHeight: 844 }),
      pageScrollTo() {}, enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {},
      async request(options) {
        const method = options.method || 'GET', route = new URL(options.url).pathname
        // Normal page hint-observation acknowledgements and the explicitly
        // requested local question are permitted; clinical writes are not used.
        assert.ok(method === 'GET' || method === 'POST' && (route === '/api/v1/agent/companion-observations' ||
          route === '/api/v1/agent/runs' && options.data.intent === 'question' && !options.data.external_message_consent),
        'The walkthrough must not submit clinical business changes.')
        try { options.success(await wire(options.url, method, method === 'GET' ? undefined : options.data, options.header)) }
        catch (error) { options.fail({ errMsg: error.message }) }
      }
    })
    function actor(key) {
      harness.storage.api_base_url = base
      require('../../miniprogram/utils/session-privacy').replacePatientSession(accounts[key])
    }
    async function load(name, query) {
      const page = harness.load(name, { query })
      pages.push(page)
      await page._loadPromise
      assert.equal(page.data.errorText || '', '', `${name}: ${page.data.errorText}`)
      return page
    }
    const close = page => page.onUnload?.()

    actor('review')
    let page = await load('assessments', ids(reviewing))
    assert.equal(page.data.assessment.id, reviewing.assessment.id)
    assert.equal(page.data.assessment.status, 'under_review')
    assert.equal(page.data.itemViews.length, 7)
    assert.ok(page.data.itemViews.every(row => row.execution_status === 'submitted' && row.acceptance_status === 'pending_review'))
    receipt.checks.patient_current_assessment = { status: page.data.assessment.status, submitted_items: page.data.itemViews.length }
    close(page)
    page = await load('review-questions', ids(reviewing))
    const question = page.data.questions.find(row => row.id === reviewing.clarification.id)
    assert.ok(question)
    assert.equal(question.replies.length, 0)
    receipt.checks.prepared_clarification_preserved = { readable: true, reply_count: question.replies.length }
    close(page)

    actor('doctor')
    page = await load('doctor-review', ids(reviewing))
    assert.equal(page.data.submissions.length, 7)
    assert.ok(page.data.submissions.every(row => row.server_result && row.originalText && row.decision === ''))
    receipt.checks.doctor_original_evidence = { originals: page.data.submissions.length, decisions_not_filled: true }
    close(page)
    page = await load('doctor-review', ids(following))
    assert.ok(page.data.reports.some(row => row.id === following.report.id))
    assert.equal(await page.openReport(event(following.report.id)), true)
    assert.equal(page.data.selectedReport.id, following.report.id)
    assert.equal(page.data.selectedReport.status, 'published')
    receipt.checks.doctor_published_report = { readable: true, version: page.data.selectedReport.version }
    close(page)

    actor('followup')
    page = await load('care-reports', ids(following))
    assert.equal(await page.openReport(event(following.report.id)), true)
    assert.ok(page.data.report.input_snapshot)
    receipt.checks.patient_published_report = { readable: true, original_input_snapshot: true }
    close(page)
    page = await load('patient-plan', ids(following))
    assert.equal(page.data.plan.id, following.plan.id)
    assert.equal(page.data.tasks.length, 14)
    assert.equal(page.data.tasks.filter(row => row.status === 'completed').length, 1)
    assert.equal(page.data.canReceive, false)
    receipt.checks.patient_professional_plan = { days: page.data.tasks.length, completed_dated_records: 1, receipt_already_saved: true }
    close(page)
    page = await load('care-cycles', { patient_id: String(following.patient_id), cycle_id: String(following.cycle.id) })
    assert.equal(page.data.cycle.cycle_type, 'professional')
    assert.equal(page.data.records.length, 1)
    assert.equal(page.data.records[0].content.focus_minutes, null)
    receipt.checks.professional_cycle = { records: 1, missing_focus_preserved: page.data.records[0].focusText === '未记录' }
    close(page)
    page = await load('care-cycles', { patient_id: String(following.patient_id), cycle_id: String(following.historical_self_cycle.id) })
    assert.equal(page.data.cycle.cycle_type, 'self')
    assert.equal(page.data.records.length, 7)
    assert.equal(page.data.cycle.summary.missing_dates.length, 7)
    assert.ok(page.data.records.some(row => row.content.focus_minutes === null && row.focusText === '未记录'))
    receipt.checks.historical_self_cycle = { elapsed_days: 14, records: 7, missing_days: 7, null_display_preserved: true }
    close(page)
    page = await load('shared-messages', { patient_id: String(following.patient_id), relationship_id: String(following.relationship.id) })
    assert.equal(page.data.messages.length, 2)
    assert.ok(new Set(page.data.messages.map(row => row.sender_user_id)).size === 2)
    receipt.checks.shared_message_history = { messages: 2, distinct_senders: 2 }
    close(page)
    page = await load('imaging-reports', { patient_id: String(source.imaging.patient_id) })
    assert.ok(page.data.reports.some(row => row.id === source.imaging.system_report_id && row.publisher_kind === 'system'))
    assert.ok(page.data.reports.some(row => row.id === source.imaging.doctor_report_id && row.publisher_kind === 'doctor'))
    assert.ok(page.data.reports.every(row => row.limitations && /不能.*诊断/.test(row.purposeLabel)))
    const doctorImaging = page.data.reports.find(row => row.id === source.imaging.doctor_report_id)
    assert.match(doctorImaging.limitations, /合成/)
    receipt.checks.imaging_reports = { system_and_doctor_versions: true, non_diagnostic_purpose_and_limitations_visible: true,
      synthetic_inputs_disclosed_in_doctor_limitations: true, reports: page.data.reports.length,
      api_demonstration_only_flags: page.data.reports.map(row => ({ publisher: row.publisher_kind, value: row.demonstration_only })),
      flag_semantics: 'Existing API sets demonstration_only from mock model execution; real HGST execution with synthetic inputs is false.' }
    close(page)
    page = await load('agent-chat', { ...ids(following), cycle_id: String(following.historical_self_cycle.id) })
    assert.ok(page.data.quickPrompts.length)
    assert.ok(page.data.runs.some(row => row.run_id === following.agent.run_id && row.status === 'completed' && row.mode === 'rules'))
    page.selectIntent({ detail: { value: String(page.data.intents.findIndex(row => row.value === 'question')) } })
    page.onInput({ detail: { value: '【合成演示】我想按实际日期做一条记录，应该从哪里开始？' } })
    assert.equal(await page.send(), true, page.data.errorText)
    let run
    for (let count = 0; count < 100; count++) {
      clearTimeout(page._pollTimer)
      run = page.data.runs.at(-1)
      if (run && !['queued', 'running'].includes(run.status)) break
      await page.refreshRun()
      await pause(50)
    }
    assert.equal(run.status, 'completed')
    assert.equal(run.mode, 'rules')
    assert.equal(run.model_round_count, 0)
    assert.ok(run.replyText && page.data.visibleRuns.some(row => row.run_id === run.run_id))
    receipt.checks.xingzai_local_help = { completed: true, mode: run.mode, model_round_count: run.model_round_count, visible_reply: true, run_id: run.run_id }
    close(page)

    assert.deepEqual(await businessSnapshot(), before, 'Read walkthrough and local question must preserve all prepared clinical business states.')
    receipt.checks.prepared_business_states_unchanged = true
    assert.ok(traffic.every(row => row.status >= 200 && row.status < 300))
    receipt.status = 'passed'
  } catch (error) {
    receipt.status = 'failed'
    receipt.failure = error.message
    process.exitCode = 1
  } finally {
    for (const page of pages) page.onUnload?.()
    harness?.restore()
    receipt.http = { requests: traffic.length, reads: traffic.filter(row => row.method === 'GET').length,
      password_logins: traffic.filter(row => row.route.endsWith('/auth/login')).length,
      local_question_posts: traffic.filter(row => row.method === 'POST' && row.route.endsWith('/agent/runs')).length,
      companion_observation_posts: traffic.filter(row => row.method === 'POST' && row.route.endsWith('/agent/companion-observations')).length,
      routes: [...new Set(traffic.map(row => `${row.method} ${row.route}`))].sort() }
    receipt.demo_writes = 'Normal page hint-observation acknowledgements and one local rule question; prepared clinical assessments, plans, dated records and clarification replies are unchanged.'
    receipt.scope_note = 'Controller and real HTTP integration only. Native WeChat rendering and device operation are not verified.'
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8')
    console.log(JSON.stringify({ status: receipt.status, checks: Object.keys(receipt.checks).length, http_requests: traffic.length,
      native_wechat_verified: false, receipt: path.relative(root, receiptPath), ...(receipt.failure ? { failure: receipt.failure } : {}) }))
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
