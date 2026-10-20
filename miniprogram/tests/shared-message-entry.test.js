const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const privacy = require('../utils/session-privacy')
const root = path.resolve(__dirname, '..')

function fixture(name, role = 'patient') {
  const storage = { access_token: 'synthetic-token', current_user: { id: 71, role } }
  const calls = { requests: [], navigation: [], modals: [], relaunch: [] }
  let definition, requestImpl = async () => ({ items: [] })
  global.wx = {
    getStorageSync: key => storage[key], removeStorageSync: key => { delete storage[key] },
    showToast() {}, navigateTo: item => calls.navigation.push(item.url),
    showModal: item => calls.modals.push(item), reLaunch: item => calls.relaunch.push(item.url)
  }
  const filename = path.join(root, 'pages', name, 'index.js')
  const localRequire = createRequire(filename)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(id) {
      if (id.endsWith('/patient-page')) return { registerPatientPage: value => { definition = value } }
      if (id.endsWith('/doctor-page')) return { registerDoctorPage: value => { definition = value } }
      if (id.endsWith('/request')) return { request: options => { calls.requests.push(options); return requestImpl(options) } }
      return localRequire(id)
    }, wx: global.wx, Date, console
  }, { filename })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(value) { Object.assign(this.data, value) } }
  return { page, storage, calls, respond(fn) { requestImpl = fn } }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const changeAccount = f => { f.storage.current_user = { ...f.storage.current_user, id: 72 } }

test('registered shared message route is the default adult and child message destination', () => {
  assert.ok(require('../app.json').pages.includes('pages/shared-messages/index'))
  for (const type of ['adult', 'child']) {
    assert.equal(require('../utils/home-dashboard').buildQuickEntries(type).find(row => row.id === 'messages').url, '/pages/shared-messages/index')
  }
})

test('legacy own history keeps original GET without global read and never sends old POST by external methods', async () => {
  const f = fixture('patient-messages')
  f.respond(async () => ({ items: [{ id: 11, content: '合成本人历史', sender_role: 'patient' }], legacy_scope_status: 'own_history_only' }))
  await f.page.onShow()
  assert.equal(f.page.data.messages[0].content, '合成本人历史')
  f.page.setData({ input: '旧输入', messages: [...f.page.data.messages, { id: 'old-failed', status: 'failed', content: '旧失败内容' }] })
  await f.page.sendMessage()
  await f.page._sendContent('禁止旧协议')
  await f.page.retryMessage({ currentTarget: { dataset: { id: 'old-failed' } } })
  assert.equal(f.calls.requests.length, 1)
  assert.equal(f.calls.requests[0].url, '/care/patient/messages')
  assert.ok(f.calls.requests.every(row => !row.method || row.method === 'GET'))
  f.page.openSharedMessages()
  assert.equal(f.calls.navigation.at(-1), '/pages/shared-messages/index')
})

for (const boundary of ['hide', 'identity', 'token', 'origin', 'end']) {
  test(`legacy own history clears private state and rejects late response after ${boundary}`, async () => {
    const f = fixture('patient-messages'), pending = deferred()
    f.respond(() => pending.promise)
    const work = f.page.onShow()
    f.page.setData({ input: '合成私有输入', messages: [{ content: '旧内容' }] })
    if (boundary === 'hide') f.page.onHide()
    if (boundary === 'identity') changeAccount(f)
    if (boundary === 'token') f.storage.access_token = 'replaced-token'
    if (boundary === 'origin') f.storage.api_base_url = 'https://other.example.test/api/v1'
    if (boundary === 'end') { privacy.advancePatientDataRevision(); f.page.onPatientSessionEnded() }
    pending.resolve({ items: [{ id: 13, sender_role: 'patient', content: '迟到历史' }] })
    await work
    assert.equal(f.page.data.input, '')
    assert.equal(f.page.data.messages.length, 0)
    f.page.openSharedMessages()
    assert.equal(f.calls.navigation.length, 0)
  })
}

test('doctor detail preserves reports and tasks but never projects or marks unverified legacy message history', async () => {
  const f = fixture('doctor-patient', 'researcher')
  f.respond(async options => options.url.endsWith('/report') ? { patient_id: 84, patient_name: '合成档案' } : { items: [{ id: 3, task_title: '合成任务', content: '不明来源旧消息' }] })
  await f.page.onLoad({ patient_id: '84' })
  assert.equal(f.page.data.report.patientName, '合成档案')
  assert.equal(f.page.data.tasks.length, 1)
  assert.equal(f.page.data.messages.length, 0)
  assert.equal(f.calls.requests.some(row => row.url.includes('/messages')), false)
  f.page.setData({ messageInput: '不能再发旧协议' })
  await f.page.sendMessage()
  assert.equal(f.calls.requests.some(row => row.method === 'POST'), false)
  f.page.openSharedMessages()
  assert.equal(f.calls.navigation.at(-1), '/pages/shared-messages/index?patient_id=84')
  changeAccount(f)
  const count = f.calls.navigation.length
  f.page.openSharedMessages()
  assert.equal(f.calls.navigation.length, count)
})

test('doctor message and pending entries bind the original valid session', () => {
  const f = fixture('doctor-home', 'researcher')
  f.page.onLoad()
  f.page.openSharedMessages(); f.page.openSubmissionQueue()
  assert.equal(f.calls.navigation.join('|'), '/pages/shared-messages/index|/pages/submission-queue/index')
  changeAccount(f)
  f.page.openSharedMessages(); f.page.openSubmissionQueue()
  assert.equal(f.calls.navigation.length, 2)
})

test('doctor logout confirms own same-origin unsynced messages and stale confirmation cannot clear new account', () => {
  const f = fixture('doctor-home', 'researcher')
  f.page.onLoad()
  const lease = privacy.capturePatientSessionLease()
  f.storage.submission_queue_v1 = { version: 1, owner: { user_id: 71, role: 'researcher', api_base_url: lease.apiBaseUrl }, entries: [{ kind: 'shared_message' }] }
  f.page.logout()
  assert.equal(f.calls.modals.length, 1)
  assert.match(f.calls.modals[0].content, /未同步.*消息.*清除/)
  assert.ok(f.storage.access_token)
  f.calls.modals[0].success({ confirm: false })
  assert.ok(f.storage.access_token)
  f.page.logout()
  changeAccount(f)
  f.calls.modals[1].success({ confirm: true })
  assert.ok(f.storage.access_token)
  assert.equal(f.calls.relaunch.length, 0)
})

test('doctor logout without own pending messages follows existing cleanup; confirmed own pending cleanup still works', () => {
  for (const pending of [false, true]) {
    const f = fixture('doctor-home', 'researcher')
    f.page.onLoad()
    if (pending) f.storage.submission_queue_v1 = { version: 1, owner: { user_id: 71, role: 'researcher', api_base_url: privacy.capturePatientSessionLease().apiBaseUrl }, entries: [{ kind: 'shared_message' }] }
    f.page.logout()
    if (pending) f.calls.modals[0].success({ confirm: true })
    assert.equal(f.storage.access_token, undefined)
    assert.equal(f.storage.submission_queue_v1, undefined)
    assert.equal(f.calls.relaunch[0], '/pages/login/index')
  }
})

test('legacy views explain unverified relationship provenance and expose working new relation entry without old composer', () => {
  for (const page of ['patient-messages', 'doctor-patient']) {
    const view = fs.readFileSync(path.join(root, 'pages', page, 'index.wxml'), 'utf8')
    assert.match(view, /旧版本|旧消息/)
    assert.match(view, /无法核实|无法核验/)
    assert.match(view, /bindtap="openSharedMessages"/)
    assert.doesNotMatch(view, /bindsubmit="sendMessage"|bindtap="sendMessage"|bindtap="retryMessage"/)
  }
  const doctor = fs.readFileSync(path.join(root, 'pages/doctor-patient/index.wxml'), 'utf8')
  assert.doesNotMatch(doctor, /还没有消息|messages.length \+ ' 条'/)
  const home = fs.readFileSync(path.join(root, 'pages/doctor-home/index.wxml'), 'utf8')
  assert.match(home, /bindtap="openSharedMessages"/)
  assert.match(home, /bindtap="openSubmissionQueue"/)
})
