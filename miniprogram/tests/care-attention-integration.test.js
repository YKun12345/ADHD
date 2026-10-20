// Actual mini controllers/request -> HTTP -> isolated stores and the production worker.
// The controlled wx bridge does not verify native WeChat rendering.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const { setTimeout: pause } = require('node:timers/promises')
const { createHarness } = require('./helpers/cognitive-harness')
const root = path.resolve(__dirname, '../..')
const verifyWeb = process.env.W05_VERIFY_WEB === 'true'
const evidenceTag = process.env.W05_EVIDENCE_TAG || `w05-http-${Date.now()}-${process.pid}`
if (!/^[a-zA-Z0-9_-]+$/.test(evidenceTag)) throw new Error('Invalid evidence tag')
const evidenceFile = suffix => path.join(root, 'docs/evidence', `${evidenceTag}-${suffix}`)
const tap = dataset => ({ currentTarget: { dataset } })

function wire(url, method = 'GET', data, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { 'content-type': 'application/json', ...headers } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', value => { body += value })
      response.on('end', () => { try { resolve({ statusCode: response.statusCode, data: JSON.parse(body) }) } catch (error) { reject(error) } })
    })
    req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
  })
}

test('actual attention page reads worker-created original evidence and stops revoked doctor access', { timeout: 150000 }, async t => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_authorization_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'true', CARE_WORKER_INTERVAL_SECONDS: '0.1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let serverLog = '', harness, loseCycleAck = false, loseActionAck = false, loseCoverageAck = false, browser, selfSubmissionId, loseTransferRoute = ''
  const actionObservations = []
  const webErrors = [], webObservations = []
  server.stdout.on('data', value => { serverLog += value }); server.stderr.on('data', value => { serverLog += value })
  const previous = { wx: global.wx, Page: global.Page, getCurrentPages: global.getCurrentPages }
  const pending = new Set(), requests = []
  const api = async (route, auth, data, expected = 200) => {
    const response = await wire(base + route, data === undefined ? 'GET' : 'POST', data,
      { ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}), ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w02-local-synthetic-fixture-only' } : {}) })
    assert.equal(response.statusCode, expected, `${route}: ${JSON.stringify(response.data)}`); return response.data
  }
  const register = (name, role = 'patient') => api('/auth/register', null, { email: `w05-attention-${name}@example.org`, full_name: '合成关注联测身份',
    password: 'Synthetic#2026', role, consent_agreed: role === 'patient', ...(role === 'patient' ? { patient_profile: { age: 26, patient_type: 'adult' } } : {}) }, 201)
  async function waitFor(read, predicate) {
    for (let count = 0; count < 200; count++) { const value = await read(); if (predicate(value)) return value; await pause(50) }
    throw new Error('Actual background consumer did not reach the required state')
  }
  async function attempt(auth, assessment, key, observed) {
    const current = await api(`/care/assessments/${assessment.id}`, auth), item = current.items.find(row => row.key === key)
    const saved = await api(`/care/assessment-items/${item.id}/attempts`, auth, { expected_item_version: item.version,
      protocol_id: item.protocol_id, protocol_schema_version: item.protocol_schema_version, config_digest: item.config_digest,
      performer_patient_id: item.kind === 'cognitive' ? current.patient_id : null, respondent_kind: item.respondent_kind, confirmed: true,
      ...(observed || { device: { platform: 'miniprogram', device_type: 'phone', viewport_width: 390, viewport_height: 844 },
        input: { method: 'touch' }, timing: { clock_source: 'performance.now', unit: 'ms' }, assistance: { provided: false, kind: 'none' } }),
      assistance: { provided: false, kind: 'none' },
      practice: { completed: false, attempts: 0, exposure_count: 0 }, recall_window: item.recall_window }, 201)
    return { item, saved }
  }
  const drain = async () => { while (pending.size) await Promise.allSettled([...pending]); await Promise.resolve(); await Promise.resolve() }
  const executeFlanker = page => {
    while (page.data.running) {
      harness.advance(100)
      page.handleAnswer(tap({ direction: page.data.stimulusText.trim().split(/\s+/)[2] === '←' ? 'left' : 'right', trial: page.data.currentTrial }))
      harness.advance(250)
    }
  }
  async function webPage(auth, relative, { denied = false } = {}) {
    if (!browser) {
      // Timing controllers finished earlier. Browser transport uses real timers.
      harness.restore()
      const puppeteer = require('puppeteer-core')
      browser = await puppeteer.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        userDataDir: fs.mkdtempSync(path.join(root, '.codex-tmp/w05-real-web-')), args: ['--no-first-run', '--no-default-browser-check'] })
    }
    const page = await browser.newPage()
    page.on('pageerror', error => webErrors.push(error.message))
    await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(({ base, auth }) => {
      window.SMARTBRAIN_API_BASE_URL = base
      localStorage.setItem('smartbrain_token', auth.access_token)
      localStorage.setItem('smartbrain_user', JSON.stringify(auth.user))
    }, { base, auth })
    await page.goto(`http://127.0.0.1:${port}/${relative}`, { waitUntil: denied ? 'domcontentloaded' : 'networkidle0' })
    await page.waitForFunction(denied => denied ? /权限|认证|授权/.test(document.querySelector('#careMessage').textContent)
      : document.querySelector('#careMessage').textContent.includes('已读取'), {}, denied)
    return page
  }
  try {
    for (let count = 0; count < 300; count++) {
      if (server.exitCode !== null) throw new Error(serverLog)
      try { if ((await wire(base + '/care/assessment-templates')).statusCode === 401) break } catch (_) {}
      if (count === 299) throw new Error('Synthetic service startup timed out')
      await pause(100)
    }
    const owner = await register('owner'), doctor = await register('doctor', 'researcher'), otherDoctor = await register('other-doctor', 'researcher')
    const pid = owner.user.patient_profile.id
    const template = (await api(`/care/assessment-templates?patient_id=${pid}`, owner)).items[0]
    const selfAssessment = await api('/care/patient/assessments', owner, { patient_id: pid, template_id: template.id, template_version: template.version, background: {} }, 201)
    harness = createHarness()
    Object.assign(harness.storage, { current_user: owner.user, access_token: owner.access_token, api_base_url: base })
    delete require.cache[require.resolve('../utils/request')]
    wx.showToast = () => {}
    wx.showModal = options => options.success({ confirm: true })
    wx.getSystemInfoSync = () => ({ platform: 'devtools', model: 'synthetic bridge', windowWidth: 390, windowHeight: 844 })
    wx.request = options => {
      const operation = wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header)
        .then(response => {
          requests.push({ url: options.url, status: response.statusCode })
          if (loseTransferRoute && options.method === 'POST' && options.url.endsWith(loseTransferRoute) && response.statusCode === 201) {
            loseTransferRoute = ''; options.fail({ errMsg: 'synthetic response lost after actual responsibility fact commit' })
          } else if (loseCoverageAck && options.method === 'POST' && options.url.endsWith('/identity/service-coverage-versions') && response.statusCode === 201) {
            loseCoverageAck = false; options.fail({ errMsg: 'synthetic response lost after actual institutional coverage commit' })
          } else if (loseActionAck && options.method === 'POST' && options.url.endsWith('/care/attention-actions') && response.statusCode === 201) {
            loseActionAck = false; options.fail({ errMsg: 'synthetic response lost after actual attention action commit' })
          } else if (loseCycleAck && options.method === 'POST' && options.url.endsWith('/care/cycles') && response.statusCode === 201) {
            loseCycleAck = false; options.fail({ errMsg: 'synthetic response lost after actual cycle commit' })
          } else options.success(response)
        })
        .catch(error => options.fail({ errMsg: error.message }))
      pending.add(operation); operation.then(() => pending.delete(operation))
    }
    let attention
    await t.test('real flanker practice/formal page produces limited evidence and actual worker-owned attention', async () => {
      const { item, saved } = await attempt(owner, selfAssessment, 'flanker', require('../utils/assessment-execution').observeDevice())
      const page = harness.load('flanker', { query: { assessment_id: String(selfAssessment.id), item_id: String(item.id), attempt_id: String(saved.id) } })
      await page._loadPromise; harness.start(page); executeFlanker(page)
      assert.equal(page.data.practicePassed, true); page.handlePracticeContinue(); executeFlanker(page); await drain()
      assert.match(page.data.syncStatus, /^已提交/); page.onUnload()
      await waitFor(() => api(`/care/patient/attention?patient_id=${pid}`, owner), value => value.items.length === 1)
      attention = harness.load('care-attention', { query: { patient_id: String(pid) } }); await attention._loadPromise
      assert.equal(attention.data.items.length, 1); const row = attention.data.items[0]
      assert.equal(row.submission_id, `wx-${saved.run_id}`); assert.equal(row.owner_kind, 'patient_self')
      selfSubmissionId = row.submission_id
      assert.equal(row.responsible_doctor_id, null); assert.match(attention.data.coverageText, /未配置/)
      assert.equal(await attention.readEvidence(tap({ id: row.id })), true)
      assert.equal(attention.data.evidence.qualityLabel, '有局限'); assert.equal(attention.data.evidence.trialCount, 24)
      assert.equal(requests.at(-1).status, 200); attention.onUnload()
    })
    await t.test('actual institutional reviewer page fixes original authority before durable save and recovers lost config ACK without POST', async () => {
      for (const clinician of [doctor, otherDoctor]) await api('/__synthetic__/authority', null, { user_id: clinician.user.id })
      const reviewer = await register('coverage-reviewer', 'researcher')
      await api('/__synthetic__/authority', null, { user_id: reviewer.user.id, reviewer: true })
      require('../utils/session-privacy').replacePatientSession({ access_token: reviewer.access_token, user: reviewer.user })
      const page = harness.load('service-coverage'); await page._loadPromise
      assert.equal(page.data.canConfigure, true, page.data.errorText)
      const index = page.data.doctors.findIndex(row => row.doctor_user_id === doctor.user.id)
      assert.ok(index >= 0)
      assert.equal(await page.selectDoctor({ detail: { value: String(index) } }), true, page.data.errorText)
      for (const [field, value] of Object.entries({ periodsText: ['周一','周二','周三','周四','周五'].flatMap(day => [`${day} 09:00-12:00`, `${day} 13:00-17:00`]).join('\n'),
        responseMinutes: '120', processReference: 'synthetic-approved-existing-process', instructions: '合成机构现实流程原文：联系既有医疗团队；无虚构号码或替班安排。' })) page.onFieldInput({ currentTarget: { dataset: { field } }, detail: { value } })
      loseCoverageAck = true
      assert.equal(await page.saveVersion(), false)
      const queue = require('../utils/submission-queue'), original = queue.pendingEntries()[0]
      assert.equal(original.kind, 'service_coverage'); assert.equal(original.payload.patient_id, undefined)
      const current = await api('/care/doctor/service-coverage', doctor)
      assert.equal(current.status, 'configured'); assert.equal(current.coverage.version, 1)
      const sent = requests.filter(row => row.url.endsWith('/identity/service-coverage-versions')).length
      page.onHide(); await page.onShow()
      const reopened = page.data.doctors.findIndex(row => row.doctor_user_id === doctor.user.id)
      assert.equal(await page.selectDoctor({ detail: { value: String(reopened) } }), true)
      assert.equal(page.data.pendingId, original.id)
      assert.equal(await page.queryPending(), true, page.data.errorText)
      assert.equal(requests.filter(row => row.url.endsWith('/identity/service-coverage-versions')).length, sent)
      assert.deepEqual(queue.pendingEntries(), [])
      actionObservations.push({ scenario: 'institutional_coverage_actual_page_lost_ack', original_client_coverage_id: original.id,
        institution_id: current.coverage.institution_id, doctor_user_id: doctor.user.id, reviewer_user_id: reviewer.user.id, version: 1, fake_patient_id: false })
      page.onUnload()
    })
    let relationship, clinicalAssessment
    await t.test('actual seven valid HTTP submissions enter the responsible doctor page without automatic acceptance', async () => {
      const invited = await api('/care/relationships/invitations', doctor, { target_email: owner.user.email, purpose: 'clinical_sharing', scope: ['profile', 'assessment', 'care'] }, 201)
      relationship = await api(`/care/relationships/${invited.id}/accept`, owner, { expected_revision: invited.revision })
      const draft = await api('/care/doctor/assessments', doctor, { patient_id: pid, template_id: template.id, template_version: template.version, background: {} }, 201)
      clinicalAssessment = await api(`/care/assessments/${draft.id}/publish`, doctor, { expected_version: draft.version })
      for (const key of ['ASRS', 'reaction', 'stroop', 'flanker', 'nback', 'trail', 'digit']) {
        const { item, saved } = await attempt(owner, clinicalAssessment, key)
        let content
        if (item.kind === 'scale') content = { scale_type: item.instrument, answers: Array(18).fill(0), recall_window: 'P6M', content_digest: item.content_digest }
        else {
          const generated = spawnSync(process.execPath, [path.join(root, 'backend/tests/w04_cognitive_fixture.cjs')],
            { input: JSON.stringify({ config: item.config, run_id: saved.run_id }), encoding: 'utf8', windowsHide: true })
          assert.equal(generated.status, 0, generated.stderr); const evidence = JSON.parse(generated.stdout)
          const metadata = Object.fromEntries(['device', 'input', 'timing', 'assistance'].map(field => [field, saved.metadata[field]]))
          content = { ...evidence.payload, execution_metadata: { ...metadata, practice: { completed: true, attempts: 1, exposure_count: 0 }, interrupted_count: 0, practice_records: evidence.practice_records } }
        }
        const body = { submission_id: `w05-http-${saved.run_id}`, kind: item.kind, patient_id: pid, assessment_id: clinicalAssessment.id,
          assessment_item_id: item.id, attempt_id: saved.id, run_id: saved.run_id, task_id: item.patient_task_id, content }
        for (const field of ['protocol_id', 'protocol_schema_version', 'config_digest', 'template_digest', 'actor_user_id', 'performer_kind', 'performer_user_id', 'performer_patient_id', 'respondent_user_id', 'respondent_kind', 'submitter_user_id']) body[field] = saved[field]
        const ack = await api('/care/submissions', owner, body, 201)
        assert.equal(ack.quality_status, 'valid'); assert.equal(ack.acceptance_status, 'pending_review')
      }
      await waitFor(() => api('/care/doctor/work_queue', doctor), value => value.items.length === 1)
      require('../utils/session-privacy').replacePatientSession({ access_token: doctor.access_token, user: doctor.user })
      attention = harness.load('care-attention'); await attention._loadPromise
      assert.equal(attention.data.items.length, 1); assert.equal(attention.data.items[0].assessment_id, clinicalAssessment.id)
      assert.equal(attention.data.items[0].responsible_doctor_id, doctor.user.id)
      assert.equal(attention.data.items[0].status, 'open')
      assert.equal(attention.data.items[0].response_coverage.coverage.version, 1)
      assert.match(attention.data.items[0].coverageText, /120.*工作分钟/)
      assert.match(attention.data.items[0].deadlineText, /北京时间/)
      const current = await api(`/care/assessments/${clinicalAssessment.id}`, owner)
      assert.equal(current.status, 'under_review'); assert.ok(current.items.every(item => item.acceptance_status === 'pending_review'))
      attention.onUnload()
      assert.equal((await api('/care/doctor/work_queue', otherDoctor)).items.length, 0)
    })
    await t.test('actual original response window creates a persisted escalation under an explicitly synthetic monitor clock', async () => {
      const actual = await api('/care/doctor/work_queue', doctor)
      const source = actual.items.find(row => row.assessment_id === clinicalAssessment.id)
      const observed = await api(`/__synthetic__/observe-deadline/${source.id}`, null, {})
      assert.equal(observed.explicit_synthetic_monitor_clock, true)
      assert.equal(observed.actual_records_saved, 1)
      require('../utils/session-privacy').replacePatientSession({ access_token: doctor.access_token, user: doctor.user })
      attention = harness.load('care-attention'); await attention._loadPromise
      const row = attention.data.items.find(value => value.id === source.id)
      assert.equal(row.status, 'open')
      assert.match(row.overdueText, /超过原期望窗口/)
      assert.match(row.overdueText, /外部通知未配置/)
      assert.match(row.overdueText, /合成机构现实流程原文/)
      assert.equal(row.overdue_observation.original_deadline, source.expected_response_at)
      actionObservations.push({ scenario: 'deadline_actual_production_monitor_with_explicit_synthetic_clock', attention_id: row.id,
        original_deadline: source.expected_response_at, observed_at: observed.observed_at, records_saved: 1,
        explicit_synthetic_monitor_clock: true, attention_status: row.status, external_delivery_status: 'not_configured' })
      attention.onUnload()
    })
    await t.test('actual personal processing preserves lost ACK original, queries without POST and resolves with a real explanation', async () => {
      require('../utils/session-privacy').replacePatientSession({ access_token: owner.access_token, user: owner.user })
      attention = harness.load('care-attention'); await attention._loadPromise
      const selfRow = attention.data.items.find(row => row.assessment_id === selfAssessment.id)
      assert.equal(await attention.openProcessing(tap({ id: selfRow.id })), true, attention.data.errorText)
      assert.equal(attention.data.processing.canAcknowledge, true)
      attention.onReasonInput({ detail: { value: '合成真实HTTP：已核对本次测试质量说明。' } })
      loseActionAck = true
      assert.equal(await attention.submitAction(tap({ id: selfRow.id, action: 'acknowledge' })), false)
      const queue = require('../utils/submission-queue'), original = queue.pendingEntries()[0]
      assert.equal(original.kind, 'attention_action')
      const serverHistory = await api(`/care/attention/${selfRow.id}/history`, owner)
      assert.equal(serverHistory.items.length, 1)
      assert.equal(serverHistory.items[0].client_action_id, original.id)
      const sent = requests.filter(row => row.url.endsWith('/care/attention-actions')).length
      attention.onHide(); await attention.onShow(); await attention.openProcessing(tap({ id: selfRow.id }))
      assert.equal(attention.data.pendingId, original.id)
      assert.equal(await attention.queryAction(), true, attention.data.errorText)
      assert.equal(requests.filter(row => row.url.endsWith('/care/attention-actions')).length, sent)
      assert.deepEqual(queue.pendingEntries(), [])
      assert.equal(attention.data.actionHistory[0].actor_user_id, owner.user.id)
      attention.onReasonInput({ detail: { value: '合成实际处理：已说明中断原因及下一次操作注意事项。' } })
      assert.equal(await attention.submitAction(tap({ id: selfRow.id, action: 'resolve' })), true, attention.data.errorText)
      assert.equal(attention.data.processing.statusLabel, '已解决')
      assert.deepEqual(attention.data.actionHistory.map(row => row.status), ['acknowledged', 'resolved'])
      const unchanged = await api(`/care/assessments/${selfAssessment.id}`, owner)
      assert.equal(unchanged.status, 'active'); assert.ok(unchanged.items.every(row => row.acceptance_status === 'not_required'))
      actionObservations.push({ scenario: 'self_lost_ack_and_real_resolution', attention_id: selfRow.id,
        original_client_action_id: original.id, original_actor_id: owner.user.id, versions: [2, 3], clinical_acceptance_changed: false })
      attention.onUnload()
    })
    await t.test('actual clinical processing is only original doctor, remains unaccepted, and acknowledged work still appears before withdrawal', async () => {
      require('../utils/session-privacy').replacePatientSession({ access_token: doctor.access_token, user: doctor.user })
      attention = harness.load('care-attention'); await attention._loadPromise
      const row = attention.data.items.find(value => value.assessment_id === clinicalAssessment.id)
      const ownerView = await api(`/care/attention/${row.id}`, owner)
      assert.deepEqual(ownerView.allowed_actions, [])
      await api(`/care/attention/${row.id}`, otherDoctor, undefined, 403)
      assert.equal(await attention.openProcessing(tap({ id: row.id })), true, attention.data.errorText)
      assert.equal(await attention.submitAction(tap({ id: row.id, action: 'acknowledge' })), true, attention.data.errorText)
      assert.equal(attention.data.actionHistory[0].actor_user_id, doctor.user.id)
      assert.equal(attention.data.actionHistory[0].status, 'acknowledged')
      const current = await api(`/care/assessments/${clinicalAssessment.id}`, owner)
      assert.equal(current.status, 'under_review'); assert.ok(current.items.every(item => item.acceptance_status === 'pending_review'))
      assert.equal((await api('/care/doctor/work_queue', doctor)).items.find(value => value.id === row.id).status, 'acknowledged')
      actionObservations.push({ scenario: 'clinical_actual_doctor_acknowledgement', attention_id: row.id,
        actor_user_id: doctor.user.id, status: 'acknowledged', clinical_acceptance_changed: false })
      attention.onUnload()
    })
    await t.test('actual institutional conflict and original 404 permit explicit archive then a fresh version with lost ACK recovery', async () => {
      const reviewer = await register('archive-coverage-reviewer', 'researcher')
      await api('/__synthetic__/authority', null, { user_id: reviewer.user.id, reviewer: true })
      require('../utils/session-privacy').replacePatientSession({ access_token: reviewer.access_token, user: reviewer.user })
      const page = harness.load('service-coverage'); await page._loadPromise
      const index = page.data.doctors.findIndex(row => row.doctor_user_id === otherDoctor.user.id)
      assert.ok(index >= 0); await page.selectDoctor({ detail: { value: String(index) } })
      assert.equal(page._original.previous, 0)
      const settings = { timezone: 'Asia/Shanghai', working_periods: [{ weekday: 0, start: '09:00', end: '12:00' }],
        expected_response_working_minutes: 60, approved_process_reference: 'synthetic-archive-approved-process',
        escalation_instructions: '合成批准现实流程，按原说明处理。' }
      await api('/identity/service-coverage-versions', reviewer, { client_coverage_id: 'actual-competing-coverage',
        doctor_user_id: otherDoctor.user.id, institution_id: page.data.institution, expected_previous_version: 0,
        ...settings, configuration_context: page._original.context }, 201)
      for (const [field, value] of Object.entries({ periodsText: '周一 09:00-12:00', responseMinutes: '60',
        processReference: settings.approved_process_reference, instructions: settings.escalation_instructions })) {
        page.onFieldInput({ currentTarget: { dataset: { field } }, detail: { value } })
      }
      assert.equal(await page.saveVersion(), false)
      const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
      assert.equal(original.write_rejection_status, 409)
      assert.equal(await page.queryPending(), false)
      assert.equal(q.pendingEntries()[0].original_query_status, 404)
      assert.equal(await page.archivePending(), true, page.data.errorText)
      assert.equal(page.data.doctorId, 0); assert.equal(page._original, null)
      assert.deepEqual(q.allEntries()[0].payload, original.payload)
      assert.equal(q.allEntries()[0].fingerprint, original.fingerprint)
      assert.equal(require('../utils/session-privacy').summarizePatientData().pendingCount, 1)
      const next = page.data.doctors.findIndex(row => row.doctor_user_id === otherDoctor.user.id)
      await page.selectDoctor({ detail: { value: String(next) } })
      assert.equal(page._original.previous, 1)
      assert.notEqual(page._original.context, original.payload.configuration_context)
      page.onFieldInput({ currentTarget: { dataset: { field: 'responseMinutes' } }, detail: { value: '120' } })
      loseCoverageAck = true; assert.equal(await page.saveVersion(), false)
      const replacement = q.pendingEntries()[0]
      assert.notEqual(replacement.id, original.id); assert.equal(replacement.payload.expected_previous_version, 1)
      const posts = requests.filter(row => row.url.endsWith('/identity/service-coverage-versions')).length
      assert.equal(await page.queryPending(), true, page.data.errorText)
      assert.equal(requests.filter(row => row.url.endsWith('/identity/service-coverage-versions')).length, posts)
      assert.equal(page.data.history.at(-1).version, 2)
      assert.equal(page.data.history.at(-1).expected_response_working_minutes, 120)
      assert.equal(q.allEntries().length, 1); assert.equal(q.allEntries()[0].id, original.id)
      assert.equal(await q.syncQueued(original.id), false)
      actionObservations.push({ scenario: 'actual_coverage_409_404_archive_then_fresh_version', original_id: original.id,
        replacement_id: replacement.id, actual_saved_version: 2, archived_original_retained: true, recovery_get_only: true })
      page.onUnload()
    })
    await t.test('actual attention conflict and original 404 permit archive then a fresh current action with lost ACK recovery', async () => {
      const actor = await register('archive-attention-owner'), patientId = actor.user.patient_profile.id
      const available = (await api(`/care/assessment-templates?patient_id=${patientId}`, actor)).items[0]
      const assessment = await api('/care/patient/assessments', actor, { patient_id: patientId,
        template_id: available.id, template_version: available.version, background: {} }, 201)
      require('../utils/session-privacy').replacePatientSession({ access_token: actor.access_token, user: actor.user })
      const { item, saved } = await attempt(actor, assessment, 'flanker', require('../utils/assessment-execution').observeDevice())
      const execution = harness.load('flanker', { query: { assessment_id: String(assessment.id), item_id: String(item.id), attempt_id: String(saved.id) } })
      await execution._loadPromise; harness.start(execution); executeFlanker(execution)
      execution.handlePracticeContinue(); executeFlanker(execution); await drain(); assert.match(execution.data.syncStatus, /^已提交/); execution.onUnload()
      await waitFor(() => api(`/care/patient/attention?patient_id=${patientId}`, actor), value => value.items.length === 1)
      const page = harness.load('care-attention'); await page._loadPromise
      const id = page.data.items[0].id; assert.equal(await page.openProcessing(tap({ id })), true)
      const detail = page._detail
      await api('/care/attention-actions', actor, { patient_id: patientId, attention_id: id, client_action_id: 'actual-competing-attention',
        expected_version: 1, action: 'acknowledge', reason: '合成并发实际确认', action_context: detail.action_context, confirmed: true }, 201)
      assert.equal(await page.submitAction(tap({ id, action: 'acknowledge' })), false)
      const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
      assert.equal(original.write_rejection_status, 409); assert.equal(await page.queryAction(), false)
      assert.equal(q.pendingEntries()[0].original_query_status, 404)
      assert.equal(await page.archivePending(), true, page.data.errorText)
      assert.equal(page.data.processing, null); assert.equal(page._detail, null)
      assert.deepEqual(q.allEntries()[0].payload, original.payload)
      assert.equal(require('../utils/session-privacy').summarizePatientData().pendingCount, 1)
      await page.openProcessing(tap({ id })); assert.equal(page.data.processing.version, 2)
      assert.equal(page.data.processing.canResolve, true)
      page.onReasonInput({ detail: { value: '合成实际当前处理说明：已完成核对。' } })
      loseActionAck = true; assert.equal(await page.submitAction(tap({ id, action: 'resolve' })), false)
      const replacement = q.pendingEntries()[0]
      assert.notEqual(replacement.id, original.id); assert.notEqual(replacement.payload.action_context, original.payload.action_context)
      const posts = requests.filter(row => row.url.endsWith('/care/attention-actions')).length
      assert.equal(await page.queryAction(), true, page.data.errorText)
      assert.equal(requests.filter(row => row.url.endsWith('/care/attention-actions')).length, posts)
      assert.equal(page.data.processing.statusLabel, '已解决')
      assert.deepEqual(page.data.actionHistory.map(row => row.status), ['acknowledged', 'resolved'])
      assert.equal(q.allEntries().length, 1); assert.equal(q.allEntries()[0].fingerprint, original.fingerprint)
      assert.equal(await q.syncQueued(original.id), false)
      actionObservations.push({ scenario: 'actual_attention_409_404_archive_then_fresh_action', original_id: original.id,
        replacement_id: replacement.id, actual_saved_version: 3, archived_original_retained: true, recovery_get_only: true })
      page.onUnload()
    })
    if (verifyWeb) await t.test('actual patient and doctor web pages read the same temporary HTTP evidence and original queue', async () => {
      const patientPage = await webPage(owner, 'patient-web/patient_care.html')
      try {
        await patientPage.click(`[data-evidence-id="${selfSubmissionId}"]`)
        await patientPage.waitForFunction(() => document.querySelector('#careEvidence').textContent.includes('有局限'))
        const visibleEvidence = await patientPage.$eval('#careEvidence', element => element.innerText)
        assert.match(visibleEvidence, /无需医生验收/); assert.match(await patientPage.$eval('#careAttention', element => element.textContent), /已解决/)
        assert.match(visibleEvidence, /正确率：100%/)
        assert.match(visibleEvidence, /已保存试次：24 次/)
        await patientPage.screenshot({ path: path.join(root, 'docs/evidence/w05-real-web-patient-attention.png'), fullPage: true })
        webObservations.push({ page: 'patient', actual_submission_id: selfSubmissionId, quality: 'limited' })
      } finally { await patientPage.close() }
      const doctorPage = await webPage(doctor, 'doctor-web/doctor_care.html')
      try {
        const href = await doctorPage.$eval('[data-assessment-link]', element => element.getAttribute('href'))
        assert.equal(href, `doctor_assessments.html?patient_id=${pid}`)
        assert.match(await doctorPage.$eval('#careAttention', element => element.textContent), /原负责医生/); assert.match(await doctorPage.$eval('#careAttention', element => element.textContent), /已确认关注/)
        assert.match(await doctorPage.$eval('#careAttention', element => element.textContent), /原窗口超时记录/)
        assert.match(await doctorPage.$eval('#careAttention', element => element.textContent), /外部通知：未配置/)
        await doctorPage.screenshot({ path: path.join(root, 'docs/evidence/w05-real-web-doctor-queue.png'), fullPage: true })
        webObservations.push({ page: 'doctor', assessment_id: clinicalAssessment.id, responsible_doctor_id: doctor.user.id,
          deadline_observation_uses_explicit_synthetic_monitor_clock: true, external_delivery_status: 'not_configured' })
      } finally { await doctorPage.close() }
      const unrelatedPage = await webPage(otherDoctor, 'doctor-web/doctor_care.html')
      try { assert.equal(await unrelatedPage.$('[data-assessment-link]'), null) } finally { await unrelatedPage.close() }
    })
    await t.test('actual background worker suspends expired clinician work and the legal owner reads the real system observation', async () => {
      await api(`/__synthetic__/expire-doctor/${doctor.user.id}`, null, {})
      const observed = await waitFor(() => api(`/care/patient/attention?patient_id=${pid}`, owner), value =>
        value.items.some(row => row.assessment_id === clinicalAssessment.id && row.status === 'suspended' && row.suspension_observation))
      const row = observed.items.find(value => value.assessment_id === clinicalAssessment.id)
      assert.equal(row.suspension_observation.reason_code, 'doctor_qualification_expired')
      assert.equal(row.suspension_observation.human_action, false)
      await api('/care/doctor/work_queue', doctor, undefined, 403)
      require('../utils/session-privacy').replacePatientSession({ access_token: owner.access_token, user: owner.user })
      attention = harness.load('care-attention'); await attention._loadPromise
      const visible = attention.data.items.find(value => value.id === row.id)
      assert.match(visible.suspensionObservationText, /后台核对时间.*医生资格/)
      assert.equal(await attention.openProcessing(tap({ id: row.id })), true, attention.data.errorText)
      assert.equal(attention.data.processing.readOnly, true)
      assert.equal(attention.data.actionHistory[0].status, 'acknowledged')
      actionObservations.push({ scenario: 'natural_qualification_expiry_persistent_pause', attention_id: row.id,
        system_principal: row.suspension_observation.system_principal, observed_at: row.suspension_observation.observed_at,
        human_action: false, reason: row.suspension_observation.reason_code })
      attention.onUnload()
      if (verifyWeb) {
        const page = await webPage(owner, 'patient-web/patient_care.html')
        try {
          assert.match(await page.$eval('#careAttention', element => element.textContent), /后台核对时间/)
          assert.match(await page.$eval('#careAttention', element => element.textContent), /医生资格有效期已到/)
          await page.screenshot({ path: path.join(root, 'docs/evidence/w05-real-web-natural-suspension.png'), fullPage: true })
          webObservations.push({ page: 'patient_natural_suspension', attention_id: row.id, reason: 'doctor_qualification_expired', human_action: false })
        } finally { await page.close() }
      }
    })
    await t.test('actual relationship withdrawal removes doctor work while the owner reads suspended history', async () => {
      await api(`/care/relationships/${relationship.id}/revoke`, owner, { expected_revision: relationship.revision })
      await waitFor(() => api(`/care/assessments/${clinicalAssessment.id}`, owner), value => value.status === 'suspended')
      require('../utils/session-privacy').replacePatientSession({ access_token: doctor.access_token, user: doctor.user })
      attention = harness.load('care-attention'); await attention._loadPromise; assert.deepEqual(attention.data.items, []); attention.onUnload()
      require('../utils/session-privacy').replacePatientSession({ access_token: owner.access_token, user: owner.user })
      attention = harness.load('care-attention', { query: { patient_id: String(pid) } }); await attention._loadPromise
      assert.ok(attention.data.items.some(row => row.assessment_id === clinicalAssessment.id && row.status === 'suspended'))
      const clinicalRow = attention.data.items.find(row => row.assessment_id === clinicalAssessment.id)
      assert.equal(await attention.openProcessing(tap({ id: clinicalRow.id })), true, attention.data.errorText)
      assert.equal(attention.data.processing.readOnly, true)
      assert.equal(attention.data.actionHistory[0].status, 'acknowledged')
      actionObservations.push({ scenario: 'acknowledged_clinical_work_suspended_after_revoke', attention_id: clinicalRow.id, history_preserved: true })
      const selfRow = attention.data.items.find(row => row.assessment_id === selfAssessment.id)
      assert.equal(await attention.readEvidence(tap({ id: selfRow.id })), true)
      assert.equal(attention.data.evidence.qualityLabel, '有局限'); attention.onUnload()
    })
    let transferId, transferredWorkId, receivingRelation
    await t.test('actual competing claim rejects the original, original-ID 404 preserves the blocker and explicit local archive enables fresh selection', async () => {
      const invited = await api('/care/relationships/invitations', otherDoctor, { target_email: owner.user.email,
        purpose: 'clinical_sharing', scope: ['profile', 'assessment', 'care'] }, 201)
      receivingRelation = await api(`/care/relationships/${invited.id}/accept`, owner, { expected_revision: invited.revision })
      require('../utils/session-privacy').replacePatientSession({ access_token: owner.access_token, user: owner.user })
      const page = harness.load('responsibility-transfers'); await page._loadPromise
      const source = page.data.sources.find(row => row.assessment_id === clinicalAssessment.id)
      assert.ok(source, page.data.errorText)
      page.selectSources({ detail: { value: [source.key] } })
      page.selectReceiver({ detail: { value: String(page.data.receivers.findIndex(row => row.doctor_user_id === otherDoctor.user.id)) } })
      const confirmModal = wx.showModal
      let competitor, modalFailure
      wx.showModal = options => {
        const operation = (async () => {
          const body = { patient_id: pid, receiving_relationship_id: receivingRelation.id, sources: [{ source_type: source.source_type,
            source_id: source.source_id, expected_version: source.expected_version }], reason: '合成并发明确授权，用于实际冲突验证。' }
          const preflight = await api('/care/responsibility-transfers/preflight', owner, body)
          competitor = await api('/care/responsibility-transfers', owner, { ...body, client_transfer_id: 'synthetic-competing-claim',
            request_context: preflight.request_context, confirmed: true }, 201)
          options.success({ confirm: true })
        })().catch(error => { modalFailure = error; options.fail() })
        pending.add(operation); operation.then(() => pending.delete(operation))
      }
      try { assert.equal(await page.propose(), false) } finally { wx.showModal = confirmModal }
      if (modalFailure) throw modalFailure
      const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
      assert.equal(original.status, 'conflict_blocked')
      assert.equal(await page.queryPending(), false); assert.equal(page.data.canArchivePending, true)
      const posts = requests.filter(row => row.url.endsWith('/care/responsibility-transfers')).length
      assert.equal(await q.retryPending(), 0)
      assert.equal(await page.archivePending(), true, page.data.errorText)
      assert.equal(page.data.pendingId, ''); assert.deepEqual(page.data.selectedSources, []); assert.equal(page.data.receiverIndex, -1)
      assert.deepEqual(q.allEntries()[0].payload, original.payload); assert.equal(q.allEntries()[0].status, 'archived_unconfirmed')
      assert.equal(requests.filter(row => row.url.endsWith('/care/responsibility-transfers')).length, posts)
      const decision = await api(`/care/responsibility-transfers/${competitor.id}`, owner)
      await api('/care/responsibility-transfer-decisions', owner, { client_decision_id: 'synthetic-competing-claim-cancel',
        patient_id: pid, transfer_id: competitor.id, expected_version: decision.version, decision: 'cancel',
        reason: '合成用户明确撤销并发请求，释放所选原事项。', decision_context: decision.decision_context, confirmed: true }, 201)
      await page.reload(); assert.ok(page.data.sources.some(row => row.key === source.key))
      assert.equal(page.selectSources({ detail: { value: [source.key] } }), true)
      actionObservations.push({ scenario: 'actual_409_then_original_404_explicit_local_archive', client_transfer_id: original.id,
        competing_transfer_id: competitor.id, immutable_original_preserved: true, server_cancel_implied: false,
        automatic_post_count: 0, new_selection_requires_fresh_confirmation: true })
      page.onUnload()
    })
    await t.test('actual user page explicitly selects revoked original work and recovers lost request ACK without resending', async () => {
      require('../utils/session-privacy').replacePatientSession({ access_token: owner.access_token, user: owner.user })
      const page = harness.load('responsibility-transfers'); await page._loadPromise
      const source = page.data.sources.find(row => row.assessment_id === clinicalAssessment.id)
      assert.ok(source, page.data.errorText)
      page.selectSources({ detail: { value: [source.key] } })
      page.selectReceiver({ detail: { value: String(page.data.receivers.findIndex(row => row.doctor_user_id === otherDoctor.user.id)) } })
      page.onReasonInput({ detail: { value: '合成用户明确授权：只交接这一个原关注，不恢复旧评估。' } })
      loseTransferRoute = '/care/responsibility-transfers'
      assert.equal(await page.propose(), false)
      const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
      assert.equal(original.kind, 'transfer_request'); assert.equal(page.data.pendingId, original.id)
      const actual = await api(`/care/responsibility-transfers?patient_id=${pid}`, owner)
      const committed = actual.items.find(row => row.request.client_transfer_id === original.id)
      assert.ok(committed); transferId = committed.request.id
      assert.equal(committed.status, 'pending_acceptance')
      assert.equal((await api('/care/transferred-work', otherDoctor)).items.length, 0)
      const posts = requests.filter(row => row.url.endsWith('/care/responsibility-transfers')).length
      page.onHide(); await page.onShow(); assert.equal(await page.queryPending(), true, page.data.errorText)
      assert.equal(requests.filter(row => row.url.endsWith('/care/responsibility-transfers')).length, posts)
      assert.deepEqual(q.pendingEntries(), []); page.onUnload()
    })
    await t.test('actual receiving doctor accepts the exact source list and recovers its immutable lost decision ACK', async () => {
      require('../utils/session-privacy').replacePatientSession({ access_token: otherDoctor.access_token, user: otherDoctor.user })
      const page = harness.load('responsibility-transfers'); await page._loadPromise
      assert.equal(await page.openRequest(tap({ id: transferId })), true, page.data.errorText)
      assert.ok(page.data.detail.actions.some(action => action.action === 'accept'))
      loseTransferRoute = '/care/responsibility-transfer-decisions'
      assert.equal(await page.decide(tap({ action: 'accept' })), false)
      const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
      assert.equal(original.kind, 'transfer_decision')
      const work = await api('/care/transferred-work', otherDoctor)
      assert.equal(work.items.length, 1); transferredWorkId = work.items[0].id
      assert.equal(work.items[0].responsible_doctor_id, otherDoctor.user.id)
      const posts = requests.filter(row => row.url.endsWith('/care/responsibility-transfer-decisions')).length
      page.onHide(); await page.onShow(); assert.equal(await page.queryPending(), true, page.data.errorText)
      assert.equal(requests.filter(row => row.url.endsWith('/care/responsibility-transfer-decisions')).length, posts)
      const originalAssessment = await api(`/care/assessments/${clinicalAssessment.id}`, owner)
      assert.equal(originalAssessment.status, 'suspended'); assert.ok(originalAssessment.items.every(item => item.acceptance_status === 'pending_review'))
      assert.equal(originalAssessment.responsible_doctor_id, doctor.user.id)
      assert.deepEqual(q.pendingEntries(), []); page.onUnload()
    })
    await t.test('actual successor controller processes accepted work with lost ACK recovery and preserves original source', async () => {
      const page = harness.load('transferred-work'); await page._loadPromise
      assert.equal(await page.openWork(tap({ id: transferredWorkId })), true, page.data.errorText)
      assert.equal(page.data.detail.work.responsible_doctor_id, otherDoctor.user.id)
      assert.equal(page.data.detail.original_evidence.original_doctor_user_id, doctor.user.id)
      loseTransferRoute = '/care/transferred-work-actions'
      assert.equal(await page.act(tap({ action: 'acknowledge' })), false)
      const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
      assert.equal(original.kind, 'transfer_work_action')
      const posts = requests.filter(row => row.url.endsWith('/care/transferred-work-actions')).length
      page.onHide(); await page.onShow(); assert.equal(await page.queryPending(), true, page.data.errorText)
      assert.equal(requests.filter(row => row.url.endsWith('/care/transferred-work-actions')).length, posts)
      assert.equal(await page.openWork(tap({ id: transferredWorkId })), true)
      assert.equal(page.data.history[0].actor_user_id, otherDoctor.user.id)
      assert.equal(page.data.history[0].status, 'acknowledged')
      assert.deepEqual(q.pendingEntries(), []); page.onUnload()
      const originalSource = (await api(`/care/patient/attention?patient_id=${pid}`, owner)).items.find(row => row.assessment_id === clinicalAssessment.id)
      assert.equal(originalSource.suspension_reason, 'responsibility_transferred'); assert.equal(originalSource.responsible_doctor_id, doctor.user.id)
      actionObservations.push({ scenario: 'actual_selected_handover_three_lost_acks', transfer_id: transferId,
        work_item_id: transferredWorkId, actual_accepting_doctor: otherDoctor.user.id, original_doctor_preserved: doctor.user.id,
        old_assessment_resumed: false, original_client_ids_recovered_without_post: true })
    })
    if (verifyWeb) await t.test('actual read-only handover pages show the same accepted doctor and actual processing history', async () => {
      const page = await browser.newPage(); page.on('pageerror', error => webErrors.push(error.message))
      try {
        await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 })
        await page.evaluateOnNewDocument(({ base, auth }) => {
          window.SMARTBRAIN_API_BASE_URL = base
          localStorage.setItem('smartbrain_token', auth.access_token); localStorage.setItem('smartbrain_user', JSON.stringify(auth.user))
        }, { base, auth: otherDoctor })
        await page.goto(`http://127.0.0.1:${port}/doctor-web/doctor_transfers.html`, { waitUntil: 'networkidle0' })
        await page.waitForFunction(() => document.querySelector('#transferMessage').textContent.includes('已读取'))
        assert.match(await page.$eval('#transferRequests', element => element.textContent), /接收医生已接受/)
        await page.click(`[data-transfer-work-id="${transferredWorkId}"]`)
        await page.waitForFunction(() => document.querySelector('#transferDetail').textContent.includes('确认关注'))
        assert.match(await page.$eval('#transferDetail', element => element.textContent), new RegExp(`账号 ${otherDoctor.user.id}`))
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        await page.screenshot({ path: path.join(root, 'docs/evidence/w05-real-web-transfer-doctor.png'), fullPage: true })
        webObservations.push({ page: 'doctor_transfer', transfer_id: transferId, work_item_id: transferredWorkId, actual_doctor: otherDoctor.user.id, read_only: true })
      } finally { await page.close() }
      const ownPage = await browser.newPage(); ownPage.on('pageerror', error => webErrors.push(error.message))
      try {
        await ownPage.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 })
        await ownPage.evaluateOnNewDocument(({ base, auth }) => {
          window.SMARTBRAIN_API_BASE_URL = base
          localStorage.setItem('smartbrain_token', auth.access_token); localStorage.setItem('smartbrain_user', JSON.stringify(auth.user))
        }, { base, auth: owner })
        await ownPage.goto(`http://127.0.0.1:${port}/patient-web/patient_transfers.html`, { waitUntil: 'networkidle0' })
        await ownPage.waitForFunction(() => document.querySelector('#transferMessage').textContent.includes('已读取'))
        await ownPage.click(`[data-transfer-work-id="${transferredWorkId}"]`)
        await ownPage.waitForFunction(() => document.querySelector('#transferDetail').textContent.includes('确认关注'))
        assert.equal(await ownPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        await ownPage.screenshot({ path: path.join(root, 'docs/evidence/w05-real-web-transfer-patient.png'), fullPage: true })
        webObservations.push({ page: 'patient_transfer', transfer_id: transferId, work_item_id: transferredWorkId, actual_accepting_doctor: otherDoctor.user.id })
      } finally { await ownPage.close() }
    })
    await t.test('actual runtime pauses accepted successor work after new receiving scope is withdrawn', async () => {
      await api(`/care/relationships/${receivingRelation.id}/revoke`, owner, { expected_revision: receivingRelation.revision })
      const result = await waitFor(() => api(`/care/transferred-work?patient_id=${pid}`, owner), value => value.items[0].status === 'suspended')
      assert.equal(result.items[0].suspension_observation.human_action, false)
      await api(`/care/transferred-work/${transferredWorkId}`, otherDoctor, undefined, 403)
      assert.equal((await api('/care/transferred-work', otherDoctor)).items.length, 0)
      actionObservations.push({ scenario: 'actual_successor_worker_scope_withdrawal', work_item_id: transferredWorkId,
        system_principal: result.items[0].suspension_observation.system_principal, human_action: false })
      require('../utils/session-privacy').replacePatientSession({ access_token: owner.access_token, user: owner.user })
    })
    let cycles, firstCycleId
    await t.test('actual cycle page retries a lost creation ACK and keeps two real date rounds with original daily revisions', async () => {
      cycles = harness.load('care-cycles'); await cycles._loadPromise
      assert.equal(cycles.data.cycles.length, 0); assert.match(cycles.data.today, /^\d{4}-\d{2}-\d{2}$/)
      const day = offset => new Date(Date.parse(`${cycles.data.today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
      cycles.onCycleDate({ currentTarget: { dataset: { field: 'startDate' } }, detail: { value: day(-27) } })
      cycles.onCycleDate({ currentTarget: { dataset: { field: 'endDate' } }, detail: { value: day(-14) } })
      loseCycleAck = true; assert.equal(await cycles.createCycle(), false)
      const queue = require('../utils/submission-queue'), original = queue.pendingEntries()[0]
      assert.equal(original.kind, 'cycle_create')
      assert.equal((await api(`/care/cycles?patient_id=${pid}`, owner)).items.length, 1)
      assert.equal(await cycles.createCycle(), true)
      assert.equal(queue.pendingEntries().length, 0); assert.equal(cycles.data.cycles.length, 1)
      firstCycleId = cycles.data.cycle.id
      cycles.selectRecordDate({ detail: { value: cycles.data.cycle.start_date } })
      cycles.onDailyInput({ currentTarget: { dataset: { field: 'focusMinutes' } }, detail: { value: '0' } })
      assert.equal(await cycles.saveDaily(), true)
      cycles.selectRecordDate({ detail: { value: cycles.data.cycle.start_date } })
      cycles.onDailyInput({ currentTarget: { dataset: { field: 'focusMinutes' } }, detail: { value: '35' } })
      assert.equal(await cycles.saveDaily(), true)
      assert.equal(cycles.data.records[0].revision, 2); assert.equal(cycles.data.cycle.summary.completed_count, 1)
      await cycles.showHistory(tap({ date: cycles.data.cycle.start_date }))
      assert.deepEqual(cycles.data.history.map(row => row.focusText), ['0 分钟', '35 分钟'])
      assert.ok(cycles.data.history.every(row => row.recorded_at === null && row.is_backfill))
      cycles.onCycleDate({ currentTarget: { dataset: { field: 'startDate' } }, detail: { value: day(-13) } })
      cycles.onCycleDate({ currentTarget: { dataset: { field: 'endDate' } }, detail: { value: day(0) } })
      assert.equal(await cycles.createCycle(), true)
      assert.notEqual(cycles.data.cycle.id, firstCycleId); assert.equal(cycles.data.cycle.summary.completed_count, 0)
      assert.equal(cycles.data.cycles.length, 2)
      await cycles.openCycle(tap({ id: firstCycleId })); assert.equal(cycles.data.cycle.summary.completed_count, 1)
    })
    await t.test('actual basic withdrawal makes the old cycle read-only while keeping every historical revision', async () => {
      const basic = (await api('/patient/consents', owner)).items.find(row => row.purpose === 'basic_use' && row.status === 'active')
      await api(`/patient/consents/${basic.id}/withdraw`, owner, { expected_revision: basic.revision })
      await cycles.reload(); await cycles.openCycle(tap({ id: firstCycleId }))
      assert.equal(cycles.data.canRecord, false); assert.equal(cycles.data.cycle.processing_status, 'suspended')
      const count = requests.length; assert.equal(await cycles.saveDaily(), false); assert.equal(requests.length, count)
      await cycles.showHistory(tap({ date: cycles.data.cycle.start_date }))
      assert.deepEqual(cycles.data.history.map(row => row.revision), [1, 2]); cycles.onUnload()
    })
    if (verifyWeb) await t.test('actual web cycle history keeps unknown original time, two immutable revisions and revoked read-only state', async () => {
      const patientPage = await webPage(owner, 'patient-web/patient_care.html')
      try {
        await patientPage.click(`[data-cycle-id="${firstCycleId}"]`)
        await patientPage.waitForSelector('[data-history-date]')
        const text = await patientPage.$eval('#careCycleDetails', element => element.textContent)
        assert.match(text, /未知/); assert.match(text, /暂停/); assert.match(text, /补录/); assert.match(text, /修订 2/)
        await patientPage.click('[data-history-date]')
        await patientPage.waitForFunction(() => document.querySelector('#careHistory').textContent.includes('修订 1'))
        assert.match(await patientPage.$eval('#careHistory', element => element.textContent), /修订 2/)
        await patientPage.screenshot({ path: path.join(root, 'docs/evidence/w05-real-web-patient-cycle.png'), fullPage: true })
        webObservations.push({ page: 'patient_cycle', cycle_id: firstCycleId, revisions: [1, 2], processing_status: 'suspended', original_time: null })
      } finally { await patientPage.close() }
      const withdrawnDoctor = await webPage(doctor, 'doctor-web/doctor_care.html', { denied: true })
      try {
        assert.equal(await withdrawnDoctor.$('[data-assessment-link]'), null)
        assert.match(await withdrawnDoctor.$eval('#careMessage', element => element.textContent), /权限|认证|授权/)
      } finally { await withdrawnDoctor.close() }
      assert.deepEqual(webErrors, [])
      fs.writeFileSync(evidenceFile('web-receipt.json'), JSON.stringify({ actual_http: true,
        synthetic_temporary_stores: true, browser_version: await browser.version(), observations: webObservations, page_errors: webErrors,
        native_wechat_verified: false }, null, 2))
    })
    fs.writeFileSync(evidenceFile('receipt.json'), JSON.stringify({ actual_http: true,
      actual_request_and_queue: true, synthetic_temporary_stores: true, observations: actionObservations, native_wechat_verified: false }, null, 2))
  } finally {
    if (browser) await browser.close()
    if (harness) harness.restore()
    Object.assign(global, previous)
    server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(evidenceFile('server.txt'), serverLog)
  }
})
