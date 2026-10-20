// Real page controllers, durable queue and request module against a disposable HTTP service.
// This bridge does not exercise native WeChat rendering or deliver external notifications.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { setTimeout: pause } = require('node:timers/promises')
const root = path.resolve(__dirname, '../..')
const verifyWeb = process.env.W05_VERIFY_SHARED_WEB === 'true'
const clone = value => value === undefined ? undefined : structuredClone(value)
function wire(url, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers: { 'content-type': 'application/json', ...headers } }, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', part => { data += part })
      response.on('end', () => { try { resolve({ statusCode: response.statusCode, data: JSON.parse(data) }) } catch (error) { reject(error) } })
    })
    request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
test('actual shared message workflow fixes recipient and original authority across lost responses and account changes', { timeout: 150000 }, async t => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_authorization_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let serverLog = '', definition, currentPage, offline = false, loseAck = false, holdAck = false, release, holdReady, browser
  const webErrors = [], browserObservations = []
  const storage = {}, requests = [], observations = [], previous = { wx: global.wx, Page: global.Page, getCurrentPages: global.getCurrentPages }
  server.stdout.on('data', value => { serverLog += value }); server.stderr.on('data', value => { serverLog += value })
  const api = async (route, auth, body, expected = 200) => {
    const response = await wire(base + route, body === undefined ? 'GET' : 'POST', body,
      { ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}), ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w02-local-synthetic-fixture-only' } : {}) })
    assert.equal(response.statusCode, expected, `${route}: ${JSON.stringify(response.data)}`); return response.data
  }
  const register = (name, role = 'patient') => api('/auth/register', null, { email: `w05-shared-${name}@example.org`, full_name: '合成消息联测身份',
    password: 'Synthetic#2026', role, consent_agreed: role === 'patient', ...(role === 'patient' ? { patient_profile: { age: 26, patient_type: 'adult' } } : {}) }, 201)
  try {
    for (let count = 0; count < 300; count++) {
      if (server.exitCode !== null) throw new Error(serverLog)
      try { if ((await wire(base + '/care/shared-messages/relationships?patient_id=1')).statusCode === 401) break } catch (_) {}
      if (count === 299) throw new Error('Synthetic service startup timed out')
      await pause(100)
    }
    storage.api_base_url = base
    global.Page = value => { definition = value }; global.getCurrentPages = () => currentPage ? [currentPage] : []
    global.wx = { getStorageSync: key => clone(storage[key]), setStorageSync: (key, value) => { storage[key] = clone(value) },
      removeStorageSync: key => { delete storage[key] }, reLaunch() {}, navigateTo() {}, showToast() {},
      request(options) {
        const isSend = options.method === 'POST' && options.url.endsWith('/care/shared-messages')
        if (isSend && offline) { requests.push({ route: '/care/shared-messages', actual_http: false, offline: true }); options.fail({ errMsg: 'synthetic offline before HTTP' }); return }
        wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header).then(response => {
          requests.push({ route: options.url.slice(base.length), method: options.method, status: response.statusCode, actual_http: true })
          if (isSend && response.statusCode === 201 && holdAck) {
            holdAck = false; release = () => options.success(response); holdReady(); return
          }
          if (isSend && response.statusCode === 201 && loseAck) {
            loseAck = false; options.fail({ errMsg: 'synthetic response lost after actual commit' }); return
          }
          options.success(response)
        }).catch(error => options.fail({ errMsg: error.message }))
      } }
    const privacy = require('../utils/session-privacy'), queue = require('../utils/submission-queue')
    async function open(auth, patientId) {
      privacy.replacePatientSession({ access_token: auth.access_token, user: auth.user })
      const file = require.resolve('../pages/shared-messages/index'); delete require.cache[file]; require(file)
      currentPage = { ...definition, data: clone(definition.data), setData(changes) { Object.assign(this.data, changes) } }
      await currentPage.onLoad({ patient_id: String(patientId) }); return currentPage
    }
    async function choose(page, id) {
      const index = page.data.relationships.findIndex(row => row.relationship_id === id)
      assert.ok(index >= 0, `Missing actual relationship: ${page.data.errorText}`)
      assert.equal(await page.selectRelationship({ detail: { value: String(index) } }), true, page.data.errorText)
    }
    const owner = await register('owner'), doctorA = await register('doctor-a', 'researcher'), doctorB = await register('doctor-b', 'researcher')
    const pid = owner.user.patient_profile.id
    const relationships = []
    for (const doctor of [doctorA, doctorB]) {
      await api('/__synthetic__/authority', null, { user_id: doctor.user.id })
      const invited = await api('/care/relationships/invitations', doctor, { target_email: owner.user.email, purpose: 'clinical_sharing', scope: ['profile', 'care'] }, 201)
      relationships.push(await api(`/care/relationships/${invited.id}/accept`, owner, { expected_revision: invited.revision }))
    }
    const [relA, relB] = relationships
    let originalMessageId
    await t.test('patient explicitly selects A and actual B cannot read either A message or its read receipt', async () => {
      const page = await open(owner, pid)
      assert.equal(page.data.relationshipId, 0); assert.equal(page.data.canSend, false)
      assert.equal(page.data.relationships.length, 2)
      await choose(page, relA.id)
      page.onContentInput({ detail: { value: '合成共享反馈，仅明确发送给医生A。' } })
      assert.equal(await page.sendMessage(), true, page.data.errorText)
      assert.equal(page.data.messages.length, 1); assert.equal(queue.pendingEntries().length, 0)
      originalMessageId = page.data.messages[0].message_id
      const scope = `/care/shared-messages?patient_id=${pid}&relationship_id=`
      assert.equal((await api(scope + relA.id, doctorA)).items.length, 1)
      assert.deepEqual((await api(scope + relB.id, doctorB)).items, [])
      await api(scope + relA.id, doctorB, undefined, 403)
      await api(`/care/shared-messages/${originalMessageId}/read`, doctorB, {}, 403)
      assert.equal(await page.markRead({ currentTarget: { dataset: { id: originalMessageId } } }), true)
      assert.match(page.data.statusText, /不代表专业处理/)
      observations.push({ scenario: 'specific_recipient', patient_id: pid, relationship_id: relA.id, message_id: originalMessageId, other_doctor_denied: true })
    })
    await t.test('actual commit with lost ACK recovers the exact original ID after page hide without a second POST', async () => {
      const page = currentPage
      page.onContentInput({ detail: { value: '合成原件：真实提交之后丢失响应。' } }); loseAck = true
      assert.equal(await page.sendMessage(), false)
      const original = queue.pendingEntries()[0]
      assert.ok(original && original.payload.relationship_id === relA.id)
      assert.equal(page.data.pendingId, original.id); assert.match(page.data.statusText, /本机/)
      page.onHide(); assert.equal(page.data.content, '')
      await page.onShow(); assert.equal(page.data.pendingId, original.id)
      const count = requests.filter(row => row.route === '/care/shared-messages' && row.method === 'POST').length
      assert.equal(await page.queryPending(), true)
      assert.equal(queue.pendingEntries().length, 0); assert.equal(page.data.messages.length, 2)
      assert.equal(requests.filter(row => row.route === '/care/shared-messages' && row.method === 'POST').length, count)
      assert.equal(page.data.messages.filter(row => row.client_message_id === original.id).length, 1)
      observations.push({ scenario: 'commit_ack_loss_original_query', client_message_id: original.id, duplicate_messages: 0 })
    })
    await t.test('doctor confirms own reply and records only the actual doctor viewer', async () => {
      const page = await open(doctorA, pid); await choose(page, relA.id)
      assert.equal(page.data.relationships.length, 1)
      assert.equal(page.data.messages.find(row => row.message_id === originalMessageId).viewer_read_at, null)
      assert.equal(await page.markRead({ currentTarget: { dataset: { id: originalMessageId } } }), true)
      page.onContentInput({ detail: { value: '合成医生本人确认回复。' } })
      assert.equal(await page.sendMessage(), true, page.data.errorText)
      const sent = page.data.messages.at(-1)
      assert.equal(sent.sender_user_id, doctorA.user.id); assert.equal(sent.sender_kind, 'doctor')
      assert.equal((await api(`/care/shared-messages?patient_id=${pid}&relationship_id=${relB.id}`, doctorB)).items.length, 0)
      const receipt = (await api(`/care/shared-messages?patient_id=${pid}&relationship_id=${relA.id}`, owner)).items.find(row => row.message_id === originalMessageId)
      assert.deepEqual(receipt.read_receipts.map(row => row.viewer_user_id).sort((a, b) => a - b), [owner.user.id, doctorA.user.id].sort((a, b) => a - b))
      observations.push({ scenario: 'doctor_confirmation_and_actual_viewers', doctor_user_id: doctorA.user.id, viewers: receipt.read_receipts.map(row => row.viewer_user_id) })
    })
    if (verifyWeb) await t.test('actual web pages read the same scoped HTTP messages and persist the actual viewer receipt', async () => {
      const puppeteer = require('puppeteer-core')
      browser = await puppeteer.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        userDataDir: fs.mkdtempSync(path.join(root, '.codex-tmp/w05-shared-real-web-')), args: ['--no-first-run', '--no-default-browser-check'] })
      for (const [role,auth,relation] of [['patient',owner,relA],['doctor',doctorA,relA],['other-doctor',doctorB,relB]]) {
        const page = await browser.newPage(); page.on('pageerror', error => webErrors.push(error.message))
        try {
          await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 })
          await page.evaluateOnNewDocument(({ base,auth }) => {
            window.SMARTBRAIN_API_BASE_URL = base
            localStorage.setItem('smartbrain_token',auth.access_token); localStorage.setItem('smartbrain_user',JSON.stringify(auth.user))
          },{ base,auth })
          await page.goto(`http://127.0.0.1:${port}/${role === 'patient' ? 'patient-web/patient_messages.html' : 'doctor-web/doctor_messages.html'}?patient_id=${pid}`,{ waitUntil:'networkidle0' })
          await page.waitForFunction(() => document.querySelector('#messageStatus').textContent.includes('已读取接收关系'))
          assert.equal(await page.$('#messageItems article'),null)
          await page.select('#messageRelationship',String(relation.id))
          await page.waitForFunction(() => document.querySelector('#messageStatus').textContent.includes('已读取当前关系'))
          const count = await page.$$eval('#messageItems article',items => items.length)
          assert.equal(count,role === 'other-doctor' ? 0 : 3)
          if (role === 'patient') {
            const reply = (await api(`/care/shared-messages?patient_id=${pid}&relationship_id=${relA.id}`,owner)).items.find(row => row.sender_kind === 'doctor')
            await page.click(`[data-message-read="${reply.message_id}"]`)
            await page.waitForFunction(() => document.querySelector('#messageStatus').textContent.includes('不代表专业处理'))
            const actual = (await api(`/care/shared-messages?patient_id=${pid}&relationship_id=${relA.id}`,owner)).items.find(row => row.message_id === reply.message_id)
            assert.ok(actual.read_receipts.some(row => row.viewer_user_id === owner.user.id))
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true)
          if (role !== 'other-doctor') await page.screenshot({ path:path.join(root,`docs/evidence/w05-shared-web-${role}.png`),fullPage:true })
          browserObservations.push({ role,patient_id:pid,relationship_id:relation.id,actual_message_count:count })
        } finally { await page.close() }
      }
      assert.deepEqual(webErrors,[])
    })
    await t.test('late actual commit response for A cannot restore its page or remove a new B original', async () => {
      const page = await open(owner, pid); await choose(page, relA.id)
      page.onContentInput({ detail: { value: '合成账号切换前已经确认的原件。' } })
      const committed = new Promise(resolve => { holdReady = resolve }); holdAck = true
      const old = page.sendMessage(); await committed
      privacy.replacePatientSession({ access_token: doctorB.access_token, user: doctorB.user })
      const context = (await api(`/care/shared-messages/relationships?patient_id=${pid}`, doctorB)).items.find(row => row.relationship_id === relB.id)
      queue.enqueue({ id: 'w05-doctor-b-retained', kind: 'shared_message', route: '/care/shared-messages',
        expected_context_digest: context.send_context_digest, expected_relationship_revision: context.relationship_revision,
        payload: { patient_id: pid, relationship_id: relB.id, client_message_id: 'w05-doctor-b-retained', content: '合成B已确认但尚未发送原件。',
          send_context: context.send_context, confirmed: true, reply_to_message_id: null } })
      release(); assert.equal(await old, false); assert.deepEqual(page.data.messages, []); assert.equal(page.data.content, '')
      assert.deepEqual(queue.pendingEntries().map(row => row.id), ['w05-doctor-b-retained'])
      const recoveryFile = require.resolve('../pages/submission-queue/index'); delete require.cache[recoveryFile]; require(recoveryFile)
      const recovery = { ...definition, data: clone(definition.data), setData(changes) { Object.assign(this.data, changes) } }
      currentPage = recovery; recovery.onLoad({})
      assert.equal(await recovery.retry({ currentTarget: { dataset: { id: 'w05-doctor-b-retained' } } }), true)
      assert.equal(queue.pendingEntries().length, 0)
      observations.push({ scenario: 'late_ack_and_doctor_recovery', new_actor_original_retained: true, new_actor_manual_retry_committed: true })
    })
    await t.test('offline original cannot borrow a new basic-use grant and remains locked to its old context', async () => {
      const page = await open(owner, pid); await choose(page, relA.id)
      page.onContentInput({ detail: { value: '合成撤回前确认的离线原件。' } }); offline = true
      assert.equal(await page.sendMessage(), false)
      const original = queue.pendingEntries()[0]; assert.ok(original)
      offline = false
      const basic = (await api('/patient/consents', owner)).items.find(row => row.purpose === 'basic_use' && row.status === 'active')
      await api(`/patient/consents/${basic.id}/withdraw`, owner, { expected_revision: basic.revision })
      await api('/patient/consents', owner, { patient_id: pid, purpose: 'basic_use', scope: basic.scope, terms_version: 'W02-1' }, 201)
      page.onHide(); await page.onShow()
      assert.equal(page.data.pendingId, original.id)
      assert.equal(await page.sendMessage(), false)
      const retained = queue.pendingEntries()[0]
      // Regrant changes the authority revision: the established server contract is 409.
      assert.equal(requests.at(-1).status, 409)
      assert.equal(retained.status, 'conflict_blocked'); assert.deepEqual(retained.payload, original.payload)
      assert.equal(retained.expected_context_digest, original.expected_context_digest)
      await api('/care/shared-messages/submissions/' + encodeURIComponent(original.id), owner, undefined, 404)
      assert.equal(page.data.content, original.payload.content)
      observations.push({ scenario: 'offline_regrant', old_original_retained: true, replacement_grant_not_borrowed: true, server_message_absent: true })
    })
    await t.test('legacy unscoped writes and batch read receipts are refused rather than sent to every doctor', async () => {
      await api('/care/patient/messages', owner, { content: '合成无关系旧请求', client_message_id: 'w05-legacy-write-refused' }, 409)
      await api(`/care/doctor/patient/${pid}/messages`, doctorA, { content: '合成无关系旧回复', client_message_id: 'w05-legacy-doctor-refused' }, 409)
      await api('/care/patient/messages/read', owner, {}, 409)
      const legacy = await api(`/care/doctor/patient/${pid}/messages`, doctorB)
      assert.deepEqual(legacy.items, []); assert.equal(legacy.legacy_scope_status, 'unverified_relationship')
      observations.push({ scenario: 'legacy_version_boundary', unscoped_writes_refused: true, unproven_legacy_not_projected: true })
    })
    fs.writeFileSync(path.join(root, 'docs/evidence/w05-shared-message-http-receipt.json'), JSON.stringify({ actual_http: true,
      actual_page_controllers: true, real_queue_and_request: true, synthetic_temporary_stores: true, observations,
      browser_observations:browserObservations,browser_version:browser ? await browser.version() : null,page_errors:webErrors,
      native_wechat_verified: false, external_notifications_sent: false }, null, 2))
  } finally {
    if (release) release()
    if (browser) await browser.close()
    Object.assign(global, previous); server.kill()
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    fs.writeFileSync(path.join(root, 'docs/evidence/w05-shared-message-http-server.txt'), serverLog)
  }
})
