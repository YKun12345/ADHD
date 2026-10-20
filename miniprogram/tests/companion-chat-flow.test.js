const test = require('node:test'), assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const hash = 'a'.repeat(64)
function setup() {
  const h = createHarness(), posts = []
  const run = { run_id: 10, actor_user_id: 7, patient_id: 8, intent: 'question', status: 'completed', original_message: '我该怎么记录今天？',
    artifact: { id: 20, run_id: 10, actor_user_id: 7, patient_id: 8, status: 'draft', source_refs: [], body: { reply: '打开日期记录，填写今天实际情况。' } } }
  const companion = { protocol: 'Xingzai-flow-1', stage_key: 'record_today', title: '下一小步', summary: '继续今天的记录', resume_action_id: null,
    updates: [{ id: hash, text: '医生的补问有了新回复。' }], fingerprint: hash, observation_context: 'signed-observation-context' }
  h.setRequest(async options => {
    if (options.url.startsWith('/agent/context?')) return { actor_user_id: 7, patient_id: 8, assessments: [] }
    if (options.url.startsWith('/agent/runs?')) return { actor_user_id: 7, patient_id: 8, items: [run] }
    if (options.url.startsWith('/agent/actions?')) return { actor_user_id: 7, patient_id: 8, items: [], companion }
    if (options.url === '/agent/companion-observations') { posts.push(options); return { observed: true, fingerprint: hash } }
    if (options.url.startsWith('/agent/run-context?')) {
      const selected = options.url.includes('context_run_ids=10')
      const ctx = { purpose: 'unified_agent_run', context_version: 1, actor_user_id: 7, role: 'patient', patient_id: 8, input_digest: hash,
        authorization_snapshot: [['authority']], credential_snapshot: [], question_mode: 'smart',
        external_ai: { field_policy_version: selected ? 'Xingzai-selected-dialogue-1' : 'Xingzai-current-message-1' },
        ...(selected ? { conversation_preview: { policy_version: 'Xingzai-selected-dialogue-1', digest: hash,
          turns: [{ run_id: 10, user_message: run.original_message, assistant_message: run.artifact.body.reply }] } } : {}) }
      return { ...ctx, question_provider_status: 'ready', run_context_digest: hash,
        run_context: `unified-agent-run-context.v1.${Buffer.from(JSON.stringify(ctx)).toString('base64url')}.${hash}` }
    }
    if (options.url === '/agent/runs') { posts.push(options); return { id: 11, run_id: 11, actor_user_id: 7, patient_id: 8, client_run_id: options.data.client_run_id,
      input_digest: hash, request_digest: hash, run_context_digest: hash, original_request: options.data, accepted: true, submission_status: 'committed', legacy: false, requested_at: '2026-10-18T00:00:00Z' } }
    if (options.url === '/care/cycles?patient_id=8') return { items: [{ id: 3, patient_id: 8, processing_status: 'active', cycle_type: 'self', start_date: '2026-10-18', end_date: '2026-10-31' }] }
    if (options.url === '/care/cycles/3') return { id: 3, patient_id: 8, processing_status: 'active', plan_version_id: null, allowed_actions: ['create_daily'],
      start_date: '2026-10-18', end_date: '2026-10-31', summary: { as_of_date: '2026-10-18' }, records: [] }
    throw new Error(options.url)
  })
  return { h, posts }
}
test('selected conversation requires full preview and explicit confirmation; cancelling or hiding sends no run', async () => {
  const { h, posts } = setup()
  try {
    const page = h.load('agent-chat', { query: { patient_id: '8' } }); await page._loadPromise
    assert.equal(page.data.companion.updates.length, 1)
    assert.equal(posts.filter(row => row.url === '/agent/companion-observations').length, 1)
    page.toggleContext({ currentTarget: { dataset: { id: 10 } } }); page.onInput({ detail: { value: '刚才那个，能一步步说吗？' } })
    assert.equal(await page.sendSmart(), false)
    assert.equal(page.data.smartPreview.turns[0].user_message, '我该怎么记录今天？')
    assert.equal(page.data.smartPreview.message, '刚才那个，能一步步说吗？')
    assert.equal(posts.some(row => row.url === '/agent/runs'), false)
    page.cancelSmartPreview(); assert.equal(page.data.inputValue, '刚才那个，能一步步说吗？')
    await page.sendSmart(); assert.equal(await page.confirmSmartPreview(), true, page.data.errorText)
    const payload = posts.find(row => row.url === '/agent/runs').data
    assert.deepEqual(payload.context_run_ids, [10]); assert.equal(payload.external_message_consent.version, 'Xingzai-selected-dialogue-1')
    page.toggleContext({ currentTarget: { dataset: { id: 10 } } }); page.onInput({ detail: { value: '继续' } }); await page.sendSmart(); page.onHide()
    assert.equal(await page.confirmSmartPreview(), false)
    assert.equal(posts.filter(row => row.url === '/agent/runs').length, 1)
    assert.equal(page.data.smartPreview, null)
  } finally { h.restore() }
})
test('conversation prepares a real-cycle original note and carries it only after confirmation without any write', async () => {
  const { h, posts } = setup()
  try {
    let url
    wx.navigateTo = options => { url = options.url }
    const page = h.load('agent-chat', { query: { patient_id: '8' } }); await page._loadPromise
    page.onInput({ detail: { value: '帮我记录：今天写作业走神了，没有测量分钟数' } })
    assert.equal(page.data.businessChoices[0].kind, 'daily')
    assert.equal(await page.prepareBusiness({ currentTarget: { dataset: { kind: 'daily' } } }), true, page.data.errorText)
    assert.equal(url, undefined); assert.equal(page.data.businessDraft.text, '今天写作业走神了，没有测量分钟数')
    assert.equal(page.confirmBusiness(), true); assert.match(url, /companion_transfer=/); assert.doesNotMatch(url, /走神/)
    assert.equal(posts.some(row => row.url !== '/agent/companion-observations'), false)
    const id = new URL('http://local' + url).searchParams.get('companion_transfer')
    const content = require('../utils/companion-transfer').consume(id, { kind: 'daily', patientId: 8, cycleId: 3, recordDate: '2026-10-18', recordRevision: 0, cycleStatus: 'active', planVersionId: null })
    assert.deepEqual(content, { note: '今天写作业走神了，没有测量分钟数' })
  } finally { require('../utils/companion-transfer').clear(); h.restore() }
})
test('updates hidden by an active run are not acknowledged until actually displayed', async () => {
  const { h, posts } = setup()
  try {
    const page = h.load('agent-chat', { query: { patient_id: '8' } }); await page._loadPromise
    const value = { ...page.data.companion, fingerprint: 'b'.repeat(64) }
    const before = posts.length
    page.setData({ hasRunning: true }); page._showCompanion(value, page._epoch); await h.flush()
    assert.equal(posts.length, before)
    page.setData({ hasRunning: false }); page._showCompanion(value, page._epoch); await h.flush()
    assert.equal(posts.length, before + 1)
  } finally { h.restore() }
})
test('returning after a changed target version restores only the same-session original, without auto-submitting', async () => {
  const { h, posts } = setup()
  try {
    let url
    wx.navigateTo = options => { url = options.url }
    const page = h.load('agent-chat', { query: { patient_id: '8' } }); await page._loadPromise
    const original = '帮我记录：今天走神了，时长未知'
    page.onInput({ detail: { value: original } }); await page.prepareBusiness({ currentTarget: { dataset: { kind: 'daily' } } })
    assert.equal(page.confirmBusiness(), true)
    const id = new URL('http://local' + url).searchParams.get('companion_transfer')
    page.onHide(); assert.equal(page.data.inputValue, '')
    const transfer = require('../utils/companion-transfer')
    assert.equal(transfer.consume(id, { kind: 'daily', patientId: 8, cycleId: 3, recordDate: '2026-10-18', recordRevision: 1, cycleStatus: 'active', planVersionId: null }), null)
    await page.onShow()
    assert.equal(page.data.inputValue, original)
    assert.match(page.data.statusText, /恢复原话/)
    assert.equal(posts.some(row => row.url !== '/agent/companion-observations'), false)
    await page.prepareBusiness({ currentTarget: { dataset: { kind: 'daily' } } }); page.confirmBusiness(); page.onHide(); transfer.clear(); await page.onShow()
    assert.equal(page.data.inputValue, '', 'background clear prevents restoration even within the same source page')
  } finally { require('../utils/companion-transfer').clear(); h.restore() }
})
