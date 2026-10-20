const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { setTimeout: pause } = require('node:timers/promises')
const { createHarness } = require('./helpers/cognitive-harness')

const root = path.resolve(__dirname, '../..')
const tap = dataset => ({ currentTarget: { dataset } })

function wire(url, method = 'GET', data, headers = {}) {
  assert.equal(new URL(url).hostname, '127.0.0.1', '合成测试只能访问隔离的本机服务器')
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, response => {
      let body = ''
      response.on('data', value => { body += value })
      response.on('end', () => {
        try { resolve({ statusCode: response.statusCode, data: JSON.parse(body) }) } catch (error) { reject(error) }
      })
    })
    req.setTimeout(20000, () => req.destroy(new Error('Synthetic HTTP request timed out')))
    req.on('error', reject)
    req.end(data === undefined ? undefined : JSON.stringify(data))
  })
}

test('actual companion hand-offs require target-page confirmation before real daily and shared-message writes', { timeout: 140000 }, async () => {
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const base = `http://127.0.0.1:${port}/api/v1`
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', XINGZAI_SYNTHETIC_LIVE_AI: '', CARE_WORKER_ENABLED: 'false', AGENT_WORKER_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = '', h, chat, daily, messages
  const traffic = [], navigation = [], pages = []
  const previousGetCurrentPages = global.getCurrentPages
  server.stdout.on('data', value => { log += value })
  server.stderr.on('data', value => { log += value })
  async function api(route, auth, body, expected = 200) {
    const result = await wire(base + route, body === undefined ? 'GET' : 'POST', body, {
      ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
      ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w06-local-synthetic-only' } : {})
    })
    assert.equal(result.statusCode, expected, `${route}: ${JSON.stringify(result.data)}`)
    return result.data
  }
  const dailyWrites = () => traffic.filter(row => row.method === 'POST' && row.url === `${base}/care/daily-records`)
  const messageWrites = () => traffic.filter(row => row.method === 'POST' && row.url === `${base}/care/shared-messages`)
  const optionsFrom = url => ({ ageGroup: 'child', query: Object.fromEntries(new URL('http://127.0.0.1' + url).searchParams) })
  try {
    for (let index = 0; index < 300; index++) {
      if (server.exitCode !== null) throw new Error(log || 'Synthetic server exited before startup')
      try { if ((await wire(base + '/care/assessment-templates')).statusCode === 401) break } catch (_) {}
      if (index === 299) throw new Error('Synthetic startup timeout')
      await pause(100)
    }
    const fixture = await api('/__synthetic__/review-source', null, { child: true })
    assert.equal(fixture.synthetic_temporary_store, true)
    const { owner, doctor, incoming, assessment } = fixture
    const patientId = assessment.patient_id
    const listing = await api(`/care/cycles?patient_id=${patientId}`, owner)
    assert.match(listing.as_of_date, /^\d{4}-\d{2}-\d{2}$/)
    const recordDate = listing.as_of_date
    const cycle = await api('/care/cycles', owner, {
      patient_id: patientId, client_cycle_id: 'companion-http-synthetic-self', cycle_type: 'self',
      start_date: recordDate,
      end_date: new Date(Date.parse(`${recordDate}T00:00:00Z`) + 13 * 86400000).toISOString().slice(0, 10)
    }, 201)
    assert.equal(cycle.patient_id, patientId)
    assert.equal((await api(`/care/cycles/${cycle.id}`, owner)).records.length, 0)

    h = createHarness()
    h.restore()
    Object.assign(h.storage, { current_user: owner.user, access_token: owner.access_token, api_base_url: base })
    delete require.cache[require.resolve('../utils/request')]
    wx.request = async options => {
      try {
        const result = await wire(options.url, options.method, options.method === 'GET' ? undefined : options.data, options.header)
        traffic.push({ url: options.url, method: options.method, data: options.data, statusCode: result.statusCode })
        options.success(result)
      } catch (error) { options.fail({ errMsg: error.message }) }
    }
    wx.navigateTo = options => { navigation.push(options.url); options.success?.() }
    global.getCurrentPages = () => pages
    const privacy = require('../utils/session-privacy')
    const transfer = require('../utils/companion-transfer')
    const queue = require('../utils/submission-queue')
    const lease = privacy.capturePatientSessionLease()
    assert.equal(privacy.isPatientSessionLeaseCurrent(lease), true)

    chat = h.load('agent-chat', { ageGroup: 'child', query: { patient_id: String(patientId) } })
    pages.push(chat)
    assert.equal(await chat._loadPromise, true, chat.data.errorText)
    assert.equal(chat.usable(), true)
    assert.equal(privacy.isPatientSessionLeaseCurrent(chat._lease), true)
    const note = '合成验证：今天写作业走神了，没有测量专注分钟数。'
    chat.onInput({ detail: { value: `帮我记录：${note}` } })
    assert.equal(chat.data.businessChoices[0].kind, 'daily')
    assert.equal(await chat.prepareBusiness(tap({ kind: 'daily' })), true, chat.data.errorText)
    if (chat._businessDraft?.binding.cycleId !== cycle.id) assert.equal(await chat.chooseBusiness(tap({ id: cycle.id })), true, chat.data.errorText)
    assert.equal(chat.data.businessDraft.text, note)
    assert.equal(chat._businessDraft.binding.recordDate, recordDate)
    assert.ok(traffic.some(row => row.url === `${base}/care/cycles/${cycle.id}` && row.method === 'GET'))
    assert.equal(dailyWrites().length, 0)
    assert.equal(navigation.length, 0)
    const dailyBinding = { ...chat._businessDraft.binding }
    assert.equal(chat.confirmBusiness(), true)
    const dailyUrl = navigation.at(-1)
    assert.match(dailyUrl, /^\/pages\/care-cycles\/index\?/)
    assert.doesNotMatch(decodeURIComponent(dailyUrl), /合成验证|走神/)
    const dailyNonce = optionsFrom(dailyUrl).query.companion_transfer
    assert.ok(dailyNonce)
    assert.equal(JSON.stringify(h.storage).includes(note), false, '交接原话不得借用持久化存储')
    chat.onHide()
    assert.equal(chat.data.inputValue, '')
    assert.equal(chat.data.businessDraft, null)
    assert.equal(privacy.isPatientSessionLeaseCurrent(lease), true, '页面隐藏不会更换实际会话')

    daily = h.load('care-cycles', optionsFrom(dailyUrl))
    pages.push(daily)
    assert.equal(await daily._loadPromise, true, daily.data.errorText)
    assert.equal(daily.data.cycle.id, cycle.id)
    assert.equal(daily.data.recordDate, recordDate)
    assert.equal(daily.data.note, note, '源页隐藏后 nonce 仍可由真实目标页消费')
    assert.equal(daily.data.focusMinutes, '')
    assert.match(daily.data.statusText, /尚未保存/)
    assert.equal(daily._current(lease, daily._version), true)
    assert.equal(transfer.consume(dailyNonce, dailyBinding), null, '交接仅消费一次')
    assert.equal(dailyWrites().length, 0)
    assert.equal(queue.pendingEntries().length, 0)
    assert.equal((await api(`/care/cycles/${cycle.id}`, owner)).records.length, 0, '目标页展示后仍没有业务写入')

    assert.equal(await daily.saveDaily(), true, `${daily.data.errorText} ${daily.data.statusText}`)
    assert.equal(dailyWrites().length, 1)
    const dailyOriginal = dailyWrites()[0].data
    assert.equal(dailyOriginal.content.note, note)
    assert.equal(dailyOriginal.content.focus_minutes, null)
    assert.equal(dailyOriginal.recorded_at, null)
    assert.equal(queue.pendingEntries().length, 0, '真实服务器 ACK 通过原队列核对')
    const savedCycle = await api(`/care/cycles/${cycle.id}`, owner)
    assert.equal(savedCycle.records.length, 1)
    const savedRecord = savedCycle.records[0]
    assert.equal(savedRecord.record_date, recordDate)
    assert.equal(savedRecord.content.note, note)
    assert.equal(savedRecord.content.focus_minutes, null, '未测量不能变成0分钟')
    assert.equal(savedRecord.recorded_at, null)
    const savedAck = await api(`/care/daily-records/${dailyOriginal.client_submission_id}`, owner)
    assert.equal(savedAck.submission_status, 'committed')
    assert.equal(savedAck.actor_user_id, owner.user.id)
    assert.equal(savedAck.content.focus_minutes, null)
    daily.onHide()
    assert.equal(daily.data.note, '')
    assert.deepEqual(daily.data.records, [])

    assert.equal(await chat.onShow(), true, chat.data.errorText)
    const messageText = '告诉医生：合成验证，我想反馈今天写作业时容易分心，请在方便时查看。'
    chat.onInput({ detail: { value: messageText } })
    assert.equal(chat.data.businessChoices[0].kind, 'message')
    assert.equal(await chat.prepareBusiness(tap({ kind: 'message' })), true, chat.data.errorText)
    const relation = chat._businessOptions.find(row => row.relation.doctor_user_id === doctor.user.id)
    assert.ok(relation, '仅选择实际接诊医生的有效共享关系')
    assert.equal(await chat.chooseBusiness(tap({ id: relation.id })), true, chat.data.errorText)
    assert.equal(chat.data.businessDraft.text, messageText)
    const messageBinding = { ...chat._businessDraft.binding }
    const messageRoute = `/care/shared-messages?patient_id=${patientId}&relationship_id=${relation.id}`
    const beforeMessages = await api(messageRoute, doctor)
    assert.equal(messageWrites().length, 0)
    assert.equal(chat.confirmBusiness(), true)
    const messageUrl = navigation.at(-1)
    assert.match(messageUrl, /^\/pages\/shared-messages\/index\?/)
    assert.doesNotMatch(decodeURIComponent(messageUrl), /合成验证|分心/)
    const messageNonce = optionsFrom(messageUrl).query.companion_transfer
    chat.onHide()
    assert.equal(chat.data.inputValue, '')
    assert.equal(chat.data.businessDraft, null)
    assert.equal(privacy.isPatientSessionLeaseCurrent(lease), true)

    messages = h.load('shared-messages', optionsFrom(messageUrl))
    pages.push(messages)
    assert.equal(await messages._loadPromise, true, messages.data.errorText)
    assert.equal(messages.data.relationshipId, relation.id)
    assert.equal(messages.data.content, messageText, messages.data.statusText)
    assert.match(messages.data.statusText, /尚未发送/)
    assert.equal(privacy.isPatientSessionLeaseCurrent(messages._pageLease), true)
    assert.equal(transfer.consume(messageNonce, messageBinding), null)
    assert.equal(messageWrites().length, 0)
    assert.equal(queue.pendingEntries().length, 0)
    assert.equal((await api(messageRoute, doctor)).items.length, beforeMessages.items.length)
    assert.equal(await messages.sendMessage(), true, `${messages.data.errorText} ${messages.data.statusText}`)
    assert.equal(messageWrites().length, 1)
    assert.equal(messageWrites()[0].data.content, messageText)
    assert.equal(messageWrites()[0].data.confirmed, true)
    assert.equal(queue.pendingEntries().length, 0)
    const doctorMessages = await api(messageRoute, doctor)
    const savedMessage = doctorMessages.items.find(row => row.client_message_id === messageWrites()[0].data.client_message_id)
    assert.ok(savedMessage)
    assert.equal(savedMessage.content, messageText)
    assert.equal(savedMessage.patient_id, patientId)
    assert.equal(savedMessage.sender_user_id, owner.user.id)
    assert.equal(savedMessage.doctor_user_id, doctor.user.id)
    assert.equal(savedMessage.relationship_id, relation.id)
    if (incoming) await api(messageRoute, incoming, undefined, 403)
    messages.onHide()
    assert.equal(messages.data.content, '')
    assert.deepEqual(messages.data.messages, [])
    assert.equal(traffic.some(row => row.method === 'POST' && row.url === `${base}/agent/runs`), false)

    fs.writeFileSync(path.join(root, 'docs/evidence/xingzai-companion-business-http-receipt.json'), JSON.stringify({
      actual_tcp_http: true, actual_mini_producer_and_target_pages: true, actual_mini_request_and_queue: true,
      synthetic_temporary_stores: true, fixture_created_via_real_api: true, real_session_leases: true,
      as_of_date_from_actual_cycles: recordDate, source_hide_keeps_one_use_memory_nonce: true,
      target_revalidates_before_consumption: true, no_daily_write_before_save: true, no_message_write_before_send: true,
      daily_post_count: dailyWrites().length, message_post_count: messageWrites().length,
      cycle_id: cycle.id, daily_record_id: savedRecord.record_id, focus_minutes: savedRecord.content.focus_minutes,
      recorded_at: savedRecord.recorded_at, exact_note_verified_by_get: true,
      relationship_id: relation.id, message_id: savedMessage.message_id, exact_message_verified_by_doctor_get: true,
      other_doctor_rejected: Boolean(incoming), target_hide_clears_input: true,
      real_model_called: false, agent_run_post_count: 0, native_wechat_verified: false
    }, null, 2))
  } finally {
    messages?.onUnload()
    daily?.onUnload()
    chat?.onUnload()
    if (h) require('../utils/companion-transfer').clear()
    h?.restore()
    if (previousGetCurrentPages === undefined) delete global.getCurrentPages
    else global.getCurrentPages = previousGetCurrentPages
    if (server.exitCode === null) {
      server.kill()
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)])
    }
    fs.writeFileSync(path.join(root, 'docs/evidence/xingzai-companion-business-http-server.txt'), log)
  }
})
