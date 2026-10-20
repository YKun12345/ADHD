const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHarness } = require('./helpers/cognitive-harness')
const { syntheticSendContext, readSyntheticContext } = require('./helpers/shared-message-context')
const tap = id => ({ currentTarget: { dataset: { id } } })
const pick = index => ({ detail: { value: String(index) } })
const input = value => ({ detail: { value } })
const relation = (id = 20, changes = {}) => ({ relationship_id: id, relationship_revision: 2,
  doctor_user_id: id === 20 ? 90 : 91, patient_actor_user_id: 7, patient_id: 8, scope: ['care'],
  can_send: true, send_context: syntheticSendContext({ relationship_id: id, doctor_user_id: id === 20 ? 90 : 91 }), send_context_digest: 'd'.repeat(64), ...changes })
const message = (changes = {}) => ({ message_id: 50, client_message_id: 'server-original', patient_id: 8,
  relationship_id: 20, relationship_revision: 2, doctor_user_id: 90, patient_actor_user_id: 7,
  sender_user_id: 90, sender_identity_basis: 'doctor:90', sender_kind: 'doctor', content: '合成医生消息',
  scope: ['care'], authorization_snapshot: [],
  confirmed: true, send_context_digest: 'd'.repeat(64), content_digest: 'c'.repeat(64), context_digest: 'b'.repeat(64),
  reply_to_message_id: null, sent_at: '2026-10-16T01:30:00Z', version: 1, legacy: false,
  submission_status: 'committed', viewer_read_at: null, read_receipts: [], ...changes })
function setup(doctor = false, options = {}) {
  const h = createHarness()
  if (doctor) h.storage.current_user = { id: 90, role: 'researcher' }
  const state = { relations: doctor ? [relation(20, { send_context: syntheticSendContext({ sender_user_id: 90, sender_identity_basis: 'doctor:90' }) })] : [relation(), relation(21)], messages: [], offline: false, sendChanges: {}, readChanges: {} }
  h.setRequest(async request => {
    if (request.url === '/identity/context') return { user_id: 7, accessible_patients: [{ patient_id: 8, display_name: '合成档案' }] }
    if (request.url === '/doctor/my_patients') return { items: [{ patient_id: 8, patient_name: '合成档案', allowed_scope: ['care'] }] }
    if (request.url.startsWith('/care/shared-messages/relationships?')) return { items: state.relations }
    if (request.method === 'POST' && request.url === '/care/shared-messages') {
      if (state.offline) throw new Error('synthetic offline')
      const original = readSyntheticContext(request.data.send_context)
      const value = message({ ...request.data, sender_user_id: doctor ? 90 : 7, sender_kind: doctor ? 'doctor' : 'patient',
        doctor_user_id: original.doctor_user_id, patient_actor_user_id: original.patient_actor_user_id, sender_identity_basis: original.sender_identity_basis, ...state.sendChanges })
      state.messages.push(value); return value
    }
    if (request.method === 'POST' && request.url.endsWith('/read')) {
      const value = { message_id: 50, viewer_user_id: doctor ? 90 : 7, read_at: '2026-10-16T01:31:00Z', ...state.readChanges }
      if (value.message_id === 50 && value.viewer_user_id === (doctor ? 90 : 7)) state.messages = state.messages.map(row => ({ ...row, viewer_read_at: value.read_at, read_receipts: [value] }))
      return value
    }
    if (request.url.startsWith('/care/shared-messages/submissions/')) {
      if (state.queryResult) return state.queryResult
      throw Object.assign(new Error('not committed'), { statusCode: 404 })
    }
    if (request.url.startsWith('/care/shared-messages?')) return { items: state.messages }
    throw new Error('Unexpected endpoint: ' + request.url)
  })
  const page = h.load('shared-messages', options)
  return { h, page, state, q: () => require('../utils/submission-queue') }
}
async function ready(value) { await value.page._loadPromise; await value.page.selectRelationship(pick(0)); return value }

test('new shared message page exists as an independent registered page definition', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '../pages/shared-messages/index.js')), true, 'new relationship-scoped page is missing')
})

test('patient uses actual accessible profile and requires explicit recipient selection', async () => {
  const v = setup()
  try {
    await v.page._loadPromise
    assert.equal(v.page.data.patientId, 8)
    assert.equal(v.page.data.relationshipId, 0)
    assert.equal(v.h.requests.some(row => row.url.startsWith('/care/shared-messages?')), false)
    assert.equal(await v.page.sendMessage(), false)
    await v.page.selectRelationship(pick(0))
    assert.equal(v.h.requests.at(-1).url, '/care/shared-messages?patient_id=8&relationship_id=20')
    assert.match(v.page.data.relationshipLabel, /90/)
  } finally { v.h.restore() }
})

test('notification deep link selects only its actual authorized relationship and rejects missing or malformed targets', async () => {
  const valid = setup(false, { query: { patient_id: '8', relationship_id: '21' } })
  try {
    await valid.page._loadPromise
    assert.equal(valid.page.data.relationshipId, 21)
    assert.ok(valid.h.requests.some(row => row.url === '/care/shared-messages?patient_id=8&relationship_id=21'))
    assert.equal(valid.h.requests.some(row => row.method === 'POST'), false)
  } finally { valid.h.restore() }
  for (const target of ['999', '21oops']) {
    const invalid = setup(false, { query: { patient_id: '8', relationship_id: target } })
    try {
      await invalid.page._loadPromise
      assert.equal(invalid.page.data.relationshipId, 0)
      assert.equal(invalid.page.data.canSend, false)
      assert.match(invalid.page.data.errorText, /关系|编号/)
      assert.equal(invalid.h.requests.some(row => row.url.startsWith('/care/shared-messages?')), false)
    } finally { invalid.h.restore() }
  }
})

test('doctor verifies deep link against actual my_patients and absent link waits for profile picker', async () => {
  const v = setup(true)
  try {
    await v.page._loadPromise
    assert.deepEqual(v.h.requests.map(row => row.url), ['/doctor/my_patients'])
    assert.equal(v.page.data.patientId, 0)
    await v.page.selectPatient(pick(0))
    assert.equal(v.h.requests.at(-1).url, '/care/shared-messages/relationships?patient_id=8')
    assert.equal(v.h.requests.some(row => row.url === '/identity/context'), false)
  } finally { v.h.restore() }
  const invalid = setup(true, { query: { patient_id: '999' } })
  try {
    await invalid.page._loadPromise
    assert.equal(invalid.page.data.patientId, 0)
    assert.equal(invalid.page.data.relationships.length, 0)
    assert.match(invalid.page.data.errorText, /档案|范围/)
    assert.deepEqual(invalid.h.requests.map(row => row.url), ['/doctor/my_patients'])
  } finally { invalid.h.restore() }
})

test('offline original survives hide and refreshed signed context without changing ID content or recipient', async () => {
  const v = await ready(setup())
  try {
    v.state.offline = true; v.page.onContentInput(input('合成固定原件'))
    assert.equal(await v.page.sendMessage(), false)
    const original = v.q().pendingEntries()[0]
    assert.equal(original.payload.send_context, relation().send_context)
    assert.equal(v.page.data.pendingId, original.id)
    v.page.onContentInput(input('不能更换原件'))
    assert.equal(v.page.data.content, '合成固定原件')
    v.page.onHide()
    assert.equal(v.page.data.content, '')
    assert.deepEqual(v.page.data.messages, [])
    assert.deepEqual(v.page.data.relationships, [])
    v.state.relations = [relation(20, { send_context: 'synthetic-new-grant-context', send_context_digest: 'e'.repeat(64) }), relation(21)]
    await v.page.onShow()
    assert.equal(v.page.data.content, '合成固定原件')
    assert.equal(v.page.data.pendingId, original.id)
    assert.equal(await v.page.sendMessage(), false)
    const posts = v.h.requests.filter(row => row.method === 'POST' && row.url === '/care/shared-messages')
    assert.equal(posts.length, 2)
    assert.deepEqual(posts[0].data, posts[1].data)
    assert.equal(v.q().pendingEntries()[0].expected_context_digest, 'd'.repeat(64))
    await v.page.selectRelationship(pick(1))
    assert.equal(v.page.data.content, '')
    assert.equal(v.page.data.pendingId, '')
    assert.equal(v.q().pendingEntries()[0].payload.relationship_id, 20)
    await v.page.selectRelationship(pick(0))
    assert.equal(v.page.data.pendingId, original.id)
  } finally { v.h.restore() }
})

test('failed local durable storage never transmits and keeps editable content', async () => {
  const v = await ready(setup())
  try {
    v.page.onContentInput(input('尚未持久保存'))
    wx.setStorageSync = () => { throw new Error('synthetic quota') }
    assert.equal(await v.page.sendMessage(), false)
    assert.equal(v.h.requests.filter(row => row.method === 'POST').length, 0)
    assert.equal(v.page.data.content, '尚未持久保存')
    assert.match(v.page.data.errorText, /保存/)
    assert.equal(v.page.data.pendingId, '')
  } finally { v.h.restore() }
})

test('uncertain local write that actually persisted locks original and next click retries same ID', async () => {
  const v = await ready(setup())
  try {
    v.state.offline = true
    v.page.onContentInput(input('读回异常时也必须保留这份原件'))
    const originalWrite = wx.setStorageSync
    wx.setStorageSync = (key, value) => { originalWrite(key, value); return false }
    assert.equal(await v.page.sendMessage(), false)
    assert.equal(v.h.requests.filter(row => row.method === 'POST').length, 0)
    const saved = v.q().pendingEntries()[0]
    assert.equal(v.page.data.pendingId, saved.id)
    v.page.onContentInput(input('不可修改已经落盘的原件'))
    assert.equal(v.page.data.content, saved.payload.content)
    wx.setStorageSync = originalWrite
    assert.equal(await v.page.sendMessage(), false)
    assert.equal(v.h.requests.at(-1).data.client_message_id, saved.id)
    assert.equal(v.q().pendingEntries().length, 1)
  } finally { v.h.restore() }
})

test('only exact ACK clears original and fresh server list displays committed message', async () => {
  const v = await ready(setup())
  try {
    v.page.onContentInput(input('已确认发送的合成内容'))
    v.state.sendChanges = { relationship_revision: 9 }
    assert.equal(await v.page.sendMessage(), false)
    assert.equal(v.q().pendingEntries().length, 1)
    assert.doesNotMatch(v.page.data.statusText, /^服务器已确认/)
    v.state.sendChanges = {}; v.state.messages = []
    assert.equal(await v.page.sendMessage(), true)
    assert.equal(v.q().pendingEntries().length, 0)
    assert.equal(v.page.data.pendingId, '')
    assert.equal(v.page.data.content, '')
    assert.equal(v.page.data.messages.length, 1)
    assert.equal(v.page.data.messages[0].content, '已确认发送的合成内容')
  } finally { v.h.restore() }
})

test('doctor sends only by explicit confirmation handler and retains doctor actual sender', async () => {
  const v = await ready(setup(true, { query: { patient_id: '8' } }))
  try {
    assert.equal(v.h.requests.filter(row => row.method === 'POST').length, 0)
    v.page.onContentInput(input('合成医生本人手写回复'))
    assert.equal(await v.page.sendMessage(), true)
    assert.equal(v.page.data.messages[0].sender_user_id, 90)
    assert.equal(v.page.data.messages[0].sender_kind, 'doctor')
    const wxml = fs.readFileSync(path.join(__dirname, '../pages/shared-messages/index.wxml'), 'utf8')
    assert.match(wxml, /确认内容和接收关系并发送/)
    assert.doesNotMatch(wxml, /rich-text|AI自动|处理完成|全体医生已读/)
  } finally { v.h.restore() }
})

test('historical relationship remains readable with sending disabled', async () => {
  const v = setup()
  try {
    await v.page._loadPromise
    v.state.relations = [relation(20, { can_send: false, send_context: null, send_context_digest: null })]
    v.state.messages = [message()]
    await v.page.reload(); await v.page.selectRelationship(pick(0))
    assert.equal(v.page.data.messages.length, 1)
    assert.equal(v.page.data.canSend, false)
    v.page.onContentInput(input('不允许借新授权发送'))
    assert.equal(await v.page.sendMessage(), false)
    assert.equal(v.h.requests.filter(row => row.url === '/care/shared-messages' && row.method === 'POST').length, 0)
  } finally { v.h.restore() }
})

test('wrong relationship or sender in server list is rejected without displaying content', async () => {
  const v = await ready(setup())
  try {
    for (const changes of [{ relationship_id: 21 }, { doctor_user_id: 99 }, { sender_user_id: 99 }, { legacy: true }, { viewer_read_at: '2026-10-16T01:31:00Z' }]) {
      v.state.messages = [message(changes)]; await v.page.reload()
      assert.deepEqual(v.page.data.messages, [], JSON.stringify(changes))
      assert.match(v.page.data.errorText, /不一致|核对/)
    }
  } finally { v.h.restore() }
})

test('read receipt requires exact actual viewer and message then rereads actual list', async () => {
  const v = await ready(setup())
  try {
    v.state.messages = [message()]; await v.page.reload()
    for (const change of [{ message_id: 99 }, { viewer_user_id: 99 }]) {
      v.state.readChanges = change
      assert.equal(await v.page.markRead(tap(50)), false)
      assert.equal(v.page.data.messages[0].viewer_read_at, null)
    }
    v.state.readChanges = {}
    assert.equal(await v.page.markRead(tap(50)), true)
    assert.equal(v.h.requests.at(-1).url, '/care/shared-messages?patient_id=8&relationship_id=20')
    assert.equal(v.page.data.messages[0].viewer_read_at, '2026-10-16T01:31:00Z')
    assert.match(v.page.data.messages[0].readLabel, /我已查看/)
  } finally { v.h.restore() }
})

test('background ACK removal reloads real list instead of claiming original still saved', async () => {
  const v = await ready(setup())
  try {
    v.state.offline = true; v.page.onContentInput(input('合成后台恢复原件')); await v.page.sendMessage()
    const original = v.q().pendingEntries()[0]
    v.state.queryResult = message({ ...original.payload, sender_user_id: 7, sender_kind: 'patient',
      sender_identity_basis: readSyntheticContext(original.payload.send_context).sender_identity_basis })
    assert.equal(await v.q().queryQueuedStatus(original.id), true)
    v.state.messages = [v.state.queryResult]
    assert.equal(await v.page.sendMessage(), false)
    assert.equal(v.page.data.pendingId, '')
    assert.equal(v.page.data.messages.length, 1)
    assert.doesNotMatch(v.page.data.statusText, /已保存在本机/)
  } finally { v.h.restore() }
})

test('late original response cannot restore content after hide, API change or actual account replacement', async () => {
  for (const boundary of ['hide', 'api', 'account']) {
    const v = await ready(setup())
    try {
      let finish
      v.h.setRequest(() => new Promise(resolve => { finish = resolve }))
      const work = v.page.reload(); await Promise.resolve()
      if (boundary === 'hide') v.page.onHide()
      else if (boundary === 'api') v.h.storage.api_base_url = 'https://different.invalid/api/v1'
      else {
        global.getCurrentPages = () => [v.page]
        require('../utils/session-privacy').replacePatientSession({ access_token: 'synthetic-B', user: { id: 9, role: 'patient' } })
      }
      finish({ accessible_patients: [{ patient_id: 8 }], items: [relation()] })
      assert.equal(await work, false)
      assert.deepEqual(v.page.data.messages, [])
      assert.equal(v.page.data.content, '')
      assert.deepEqual(v.page.data.relationships, [])
      if (boundary === 'account') assert.equal(await v.page.onShow(), false)
    } finally { v.h.restore() }
  }
})

test('only patient can open separately labelled legacy self history', async () => {
  const v = setup()
  try {
    await v.page._loadPromise
    const urls = []; wx.navigateTo = options => urls.push(options.url)
    assert.equal(v.page.openLegacy(), true)
    assert.deepEqual(urls, ['/pages/patient-messages/index'])
  } finally { v.h.restore() }
  const doctor = setup(true)
  try {
    await doctor.page._loadPromise
    wx.navigateTo = () => { throw new Error('doctor must not open legacy history') }
    assert.equal(doctor.page.openLegacy(), false)
  } finally { doctor.h.restore() }
})

test('query pending uses the original submission ID and reloads actual committed list', async () => {
  const v = await ready(setup())
  try {
    v.state.offline = true; v.page.onContentInput(input('丢失确认的原件')); await v.page.sendMessage()
    const item = v.q().pendingEntries()[0]
    v.state.queryResult = message({ ...item.payload, sender_user_id: 7, sender_kind: 'patient',
      sender_identity_basis: readSyntheticContext(item.payload.send_context).sender_identity_basis })
    v.state.messages = [v.state.queryResult]
    assert.equal(await v.page.queryPending(), true)
    assert.equal(v.h.requests.some(row => row.url === '/care/shared-messages/submissions/' + item.id), true)
    assert.equal(v.page.data.pendingId, '')
    assert.equal(v.page.data.content, '')
    assert.equal(v.page.data.messages.length, 1)
    assert.equal(v.q().pendingEntries().length, 0)
  } finally { v.h.restore() }
})

test('late send ACK after hide clears only durable original and cannot restore page content', async () => {
  const v = await ready(setup())
  try {
    let finish, posted
    v.h.setRequest(options => { posted = options.data; return new Promise(resolve => { finish = resolve }) })
    v.page.onContentInput(input('隐藏期间才收到确认'))
    const work = v.page.sendMessage(); await Promise.resolve()
    v.page.onHide()
    finish(message({ ...posted, sender_user_id: 7, sender_kind: 'patient',
      sender_identity_basis: readSyntheticContext(posted.send_context).sender_identity_basis }))
    assert.equal(await work, false)
    assert.deepEqual(v.page.data.messages, [])
    assert.equal(v.page.data.content, '')
    assert.equal(v.q().pendingEntries().length, 0)
  } finally { v.h.restore() }
})

test('doctor rejects another actual doctor in returned relationship scope', async () => {
  const v = setup(true, { query: { patient_id: '8' } })
  try {
    await v.page._loadPromise
    v.state.relations = [relation(21)]
    assert.equal(await v.page.reload(), false)
    assert.deepEqual(v.page.data.relationships, [])
    assert.equal(v.page.data.canSend, false)
    assert.match(v.page.data.errorText, /不一致|核对/)
  } finally { v.h.restore() }
})

test('same token cannot substitute another account and A to B to A cannot revive the old page', async () => {
  const v = await ready(setup())
  try {
    v.page.onContentInput(input('不能交给另一账号的内容'))
    v.h.storage.current_user = { id: 9, role: 'patient' }
    assert.equal(await v.page.sendMessage(), false)
    assert.deepEqual(v.page.data.relationships, [])
    assert.equal(v.page.data.content, '')
    v.h.storage.current_user = { id: 7, role: 'patient' }
    assert.equal(await v.page.onShow(), false)
    assert.deepEqual(v.page.data.messages, [])
  } finally { v.h.restore() }
  const actual = await ready(setup())
  try {
    global.getCurrentPages = () => [actual.page]
    const privacy = require('../utils/session-privacy')
    privacy.replacePatientSession({ access_token: 'synthetic-B', user: { id: 9, role: 'patient' } })
    privacy.replacePatientSession({ access_token: 'test-token', user: { id: 7, role: 'patient' } })
    assert.equal(await actual.page.onShow(), false)
    assert.deepEqual(actual.page.data.relationships, [])
    assert.equal(actual.page.data.content, '')
  } finally { actual.h.restore() }
})
