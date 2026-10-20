const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

function setup({ loseAck = false } = {}) {
  const h = createHarness(), hash = 'a'.repeat(64), posts = [], modes = [], acks = []
  h.setRequest(async options => {
    if (options.url.startsWith('/agent/run-context?')) {
      const smart = options.url.includes('question_mode=smart'); modes.push(smart ? 'smart' : 'local')
      const ctx = { purpose: 'unified_agent_run', context_version: 1, actor_user_id: 7, role: 'patient', patient_id: 8,
        input_digest: hash, authorization_snapshot: [['actual-authority']], credential_snapshot: [], question_mode: smart ? 'smart' : 'local',
        external_ai: smart ? { id: 3, required_scopes: ['care'], field_policy_version: 'Xingzai-current-message-1' } : null }
      return { ...ctx, question_provider_status: 'ready', run_context_digest: hash,
        run_context: `unified-agent-run-context.v1.${Buffer.from(JSON.stringify(ctx)).toString('base64url')}.${hash}` }
    }
    if (options.url.startsWith('/agent/context?')) return { actor_user_id: 7, patient_id: 8, assessments: [] }
    if (options.url.startsWith('/agent/actions?')) return { actor_user_id: 7, patient_id: 8, items: [] }
    if (options.url.startsWith('/agent/runs?')) return { actor_user_id: 7, patient_id: 8, items: [] }
    if (options.url.startsWith('/agent/runs/submissions/')) return acks.find(ack => ack.client_run_id === options.url.split('/').pop())
    if (options.url === '/agent/runs') {
      posts.push(options.data)
      const ack = { id: posts.length, run_id: posts.length, client_run_id: options.data.client_run_id, actor_user_id: 7, patient_id: 8,
        input_digest: hash, request_digest: hash, run_context_digest: hash, original_request: options.data, accepted: true,
        submission_status: 'committed', legacy: false, requested_at: '2026-10-17T12:00:00+00:00' }
      acks.push(ack)
      if (loseAck) throw new Error('Synthetic ACK lost after commit')
      return ack
    }
    throw new Error('Unexpected route ' + options.url)
  })
  return { h, posts, modes }
}

test('smart cancel preserves input, sends nothing, and ordinary send never confirms external text', async () => {
  const { h, posts, modes } = setup()
  try {
    let confirmations = 0
    wx.showModal = options => { confirmations++; options.success({ confirm: false }) }
    const page = h.load('agent-chat', { query: { patient_id: '8' } }); await page._loadPromise
    page.onInput({ detail: { value: '请陪我把事情理清楚' } })
    assert.equal(await page.sendSmart(), false)
    assert.equal(posts.length, 0); assert.equal(page.data.inputValue, '请陪我把事情理清楚')
    assert.equal(await page.send(), true)
    assert.equal(confirmations, 1); assert.deepEqual(modes, ['smart', 'local'])
    assert.equal(posts[0].external_message_consent, undefined)
  } finally { h.restore() }
})

test('every smart message freezes its current text and requires a new confirmation', async () => {
  const { h, posts } = setup()
  try {
    const page = h.load('agent-chat', { query: { patient_id: '8' } }); await page._loadPromise
    let confirmations = 0
    wx.showModal = options => {
      confirmations++
      assert.match(options.content, /DeepSeek/); assert.match(options.content, /历史/)
      page.onInput({ detail: { value: '未确认的新文字' } })
      options.success({ confirm: true })
    }
    page.onInput({ detail: { value: '本次确认的文字' } })
    assert.equal(await page.sendSmart(), true, page.data.errorText || page.data.statusText)
    assert.equal(posts[0].message, '本次确认的文字')
    assert.deepEqual(posts[0].external_message_consent, { version: 'Xingzai-current-message-1', confirmed: true })
    assert.equal(page.data.pendingId, ''); assert.equal(page.data.inputValue, '')
    h.advance(1)
    page.onInput({ detail: { value: '下一次文字' } })
    assert.equal(await page.sendSmart(), true)
    assert.equal(confirmations, 2)
    page.onInput({ detail: { value: '回到本机帮助' } }); h.advance(1)
    assert.equal(await page.send(), true)
    assert.equal(posts[2].external_message_consent, undefined)
    assert.equal(confirmations, 2)
  } finally { h.restore() }
})

test('lost smart ACK preserves confirmed text and recovers by GET without sending another model request', async () => {
  const { h, posts } = setup({ loseAck: true })
  try {
    wx.showModal = options => options.success({ confirm: true })
    const page = h.load('agent-chat', { query: { patient_id: '8' } }); await page._loadPromise
    page.onInput({ detail: { value: '只确认这次文字，丢回复后不要重新发模型请求' } })
    assert.equal(await page.sendSmart(), false)
    assert.ok(page.data.pendingId)
    assert.equal(require('../utils/submission-queue').pendingEntries()[0].payload.message, posts[0].message)
    assert.equal(await page.queryPending(), true)
    assert.equal(page.data.pendingId, ''); assert.equal(posts.length, 1)
    assert.equal(h.requests.filter(row => row.url.startsWith('/agent/runs/submissions/')).length, 1)
  } finally { h.restore() }
})

test('hiding the page while permission is pending prevents its later confirmation from sending', async () => {
  const { h, posts } = setup()
  try {
    const page = h.load('agent-chat', { query: { patient_id: '8' } }); await page._loadPromise
    let modal
    wx.showModal = options => { modal = options }
    page.onInput({ detail: { value: '私人本次文字' } })
    const sending = page.sendSmart(); await h.flush()
    assert.ok(modal)
    page.onHide(); modal.success({ confirm: true })
    assert.equal(await sending, false); assert.equal(posts.length, 0)
  } finally { h.restore() }
})

test('model failure is visibly distinguished from a completed intelligent answer', () => {
  const { presentRun } = require('../utils/xingzai-chat')
  const row = { intent: 'question', question_mode: 'smart', status: 'completed', mode: 'rules', error_code: 'model_timeout' }
  assert.match(presentRun(row, 'patient').answerNotice, /智能回答未完成/)
  assert.match(presentRun({ ...row, mode: 'remote' }, 'patient').answerNotice, /DeepSeek/)
  assert.match(presentRun({ ...row, error_code: 'local_safety_boundary' }, 'patient').answerNotice, /未发送/)
})
