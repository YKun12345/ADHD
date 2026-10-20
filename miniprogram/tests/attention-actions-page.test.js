const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const tap = (id = 11, action) => ({ currentTarget: { dataset: { id, action } } })
const row = status => ({ id: 11, patient_id: 8, assessment_id: 42, submission_id: null, kind: 'assessment_quality', owner_kind: 'patient_self',
  responsible_doctor_id: null, status, version: status === 'open' ? 1 : 2, quality_reasons: [], response_coverage: { status: 'not_configured' }, allowed_actions: ['view_assessment'] })
const originalContext = () => 'attention-action-context.v1.' + Buffer.from(JSON.stringify({ purpose: 'attention_action', version: 1,
  actor_user_id: 7, actor_identity_basis: 'self:7:access:1:revision:1', patient_id: 8, attention_id: 11,
  expected_version: 1, previous_status: 'open', authorization_snapshot: [] })).toString('base64url') + '.' + 'a'.repeat(64)
function arrange(h, { offline = false } = {}) {
  let committed = null
  h.setRequest(async options => {
    if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 8 }] }
    if (options.url === '/care/patient/attention?patient_id=8') return { items: [row(committed ? 'acknowledged' : 'open')] }
    if (options.url === '/care/attention/11') return { attention: row(committed ? 'acknowledged' : 'open'),
      allowed_actions: committed ? ['resolve', 'close_with_reason'] : ['acknowledge', 'close_with_reason'],
      action_context: originalContext(), action_context_digest: 'd'.repeat(64) }
    if (options.url === '/care/attention/11/history') return { items: committed ? [committed] : [] }
    if (options.url === '/care/attention-actions' || options.url.startsWith('/care/attention-actions/')) {
      if (!committed) committed = { action_id: 20, ...options.data, actor_user_id: 7, actor_identity_basis: 'self:7:access:1:revision:1',
        previous_status: 'open', status: 'acknowledged', version: 2, occurred_at: '2026-10-16T01:00:00+00:00',
        action_context_digest: 'd'.repeat(64), authorization_snapshot: [], submission_status: 'committed', confirmed: true, legacy: false }
      if (offline && options.method === 'POST') throw new Error('synthetic ACK lost after commit')
      return committed
    }
    throw new Error('unexpected route ' + options.url)
  })
  wx.showModal = options => options.success({ confirm: true })
}

test('a confirmed actual action is durable before transmission and shows saved actual actor history without clinical acceptance', async () => {
  const h = createHarness()
  try {
    arrange(h)
    const page = h.load('care-attention'); await page._loadPromise
    assert.equal(await page.openProcessing(tap()), true)
    assert.equal(page.data.processing.id, 11)
    assert.equal(page.data.processing.canAcknowledge, true)
    assert.equal(await page.submitAction(tap(11, 'acknowledge')), true)
    assert.equal(h.requests.filter(value => value.method === 'POST').length, 1)
    assert.ok(h.writes.some(([key, value]) => key === 'submission_queue_v1' && value.entries.length === 1))
    assert.equal(page.data.processing.statusLabel, '已确认关注')
    assert.equal(page.data.items[0].status, 'acknowledged')
    assert.equal(page.data.actionHistory[0].actorLabel, '账号 7')
    assert.match(page.data.statusText, /服务器|确认/)
    assert.deepEqual(require('../utils/submission-queue').pendingEntries(), [])
  } finally { h.restore() }
})

test('lost action ACK keeps original immutable reason and context across hide, then original ID query recovers without another POST', async () => {
  const h = createHarness()
  try {
    arrange(h, { offline: true })
    const page = h.load('care-attention'); await page._loadPromise; await page.openProcessing(tap())
    page.onReasonInput({ detail: { value: '合成确认说明，原样保留。' } })
    assert.equal(await page.submitAction(tap(11, 'acknowledge')), false)
    const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
    assert.equal(original.payload.reason, '合成确认说明，原样保留。')
    page.onHide(); assert.equal(page.data.processing, null); assert.deepEqual(page.data.actionHistory, [])
    await page.onShow(); await page.openProcessing(tap())
    assert.equal(page.data.pendingId, original.id)
    page.onReasonInput({ detail: { value: 'cannot edit saved original' } })
    assert.equal(q.pendingEntries()[0].payload.reason, original.payload.reason)
    assert.equal(await page.queryAction(), true)
    assert.equal(h.requests.filter(value => value.method === 'POST').length, 1)
    assert.deepEqual(q.pendingEntries(), [])
  } finally { h.restore() }
})

test('resolve or close needs an actual reason, cancellation and storage failure transmit nothing', async () => {
  const h = createHarness()
  try {
    arrange(h)
    const page = h.load('care-attention'); await page._loadPromise; await page.openProcessing(tap())
    assert.equal(await page.submitAction(tap(11, 'close_with_reason')), false)
    page.onReasonInput({ detail: { value: '合成关闭原因' } })
    wx.showModal = options => options.success({ confirm: false })
    assert.equal(await page.submitAction(tap(11, 'close_with_reason')), false)
    wx.showModal = options => options.success({ confirm: true })
    wx.setStorageSync = () => { throw new Error('synthetic full') }
    assert.equal(await page.submitAction(tap(11, 'close_with_reason')), false)
    assert.equal(h.requests.filter(value => value.method === 'POST').length, 0)
    assert.match(page.data.errorText, /保存|存储/)
  } finally { h.restore() }
})

test('late original confirmation modal cannot act as B, and an old hidden A page cannot revive on B show', async () => {
  const h = createHarness()
  try {
    arrange(h)
    const page = h.load('care-attention'); await page._loadPromise; await page.openProcessing(tap())
    let confirm
    wx.showModal = options => { confirm = options.success }
    const pending = page.submitAction(tap(11, 'acknowledge')); await Promise.resolve()
    page.onHide()
    require('../utils/session-privacy').replacePatientSession({ access_token: 'synthetic-B', user: { id: 9, role: 'patient', patient_profile: { id: 10 } } })
    confirm({ confirm: true })
    assert.equal(await pending, false)
    assert.equal(await page.onShow(), false)
    assert.equal(h.requests.filter(value => value.method === 'POST').length, 0)
    assert.equal(page.data.processing, null)
  } finally { h.restore() }
})

test('a committed action with a failed history refresh says committed without claiming refreshed history or repeating POST', async () => {
  const h = createHarness()
  try {
    arrange(h)
    const page = h.load('care-attention'); await page._loadPromise; await page.openProcessing(tap())
    let committed = false
    h.setRequest(async options => {
      if (options.url === '/care/attention-actions') {
        committed = true
        return { action_id: 20, ...options.data, actor_user_id: 7, actor_identity_basis: 'self:7:access:1:revision:1', previous_status: 'open',
          status: 'acknowledged', version: 2, occurred_at: '2026-10-16T01:00:00+00:00', action_context_digest: 'd'.repeat(64),
          authorization_snapshot: [], submission_status: 'committed', confirmed: true, legacy: false }
      }
      if (options.url === '/care/attention/11') return { attention: row('acknowledged'), allowed_actions: ['resolve', 'close_with_reason'], action_context: originalContext(), action_context_digest: 'd'.repeat(64) }
      if (committed && options.url.endsWith('/history')) throw Object.assign(new Error('synthetic read audit unavailable'), { statusCode: 503 })
      throw new Error('unexpected fixture request')
    })
    assert.equal(await page.submitAction(tap(11, 'acknowledge')), true)
    assert.match(page.data.statusText, /服务器已确认/)
    assert.doesNotMatch(page.data.statusText, /历史已重新读取/)
    assert.deepEqual(page.data.actionHistory, [])
    assert.deepEqual(require('../utils/submission-queue').pendingEntries(), [])
    assert.equal(h.requests.filter(value => value.method === 'POST').length, 1)
  } finally { h.restore() }
})
