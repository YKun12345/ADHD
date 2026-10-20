const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

test('doctor reminder and greeting address the doctor and identify reminders separately from replies', async () => {
  const h = source('researcher')
  try {
    const page = h.load('agent-chat', { query: { patient_id: '8' } })
    await page._loadPromise
    assert.match(page.data.welcomeText, /医生/)
    assert.match(page.data.serviceLabel, /医生助手/)
    const { actionView } = require('../utils/xingzai-actions')
    const report = actionView({ kind: 'read_report' }, 'researcher')
    assert.match(report.leadText, /用户/)
    assert.doesNotMatch(report.leadText, /医生已发布意见，你/)
  } finally { h.restore() }
})

test('business reminders are visibly labelled outside the assistant answer bubbles', () => {
  const fs = require('node:fs'), path = require('node:path')
  const view = fs.readFileSync(path.join(__dirname, '../pages/agent-chat/index.wxml'), 'utf8')
  assert.match(view, /class="business-reminder"/)
  assert.match(view, /业务提醒/)
  assert.match(view, /共享消息/)
  assert.doesNotMatch(view, /接着上次这一步继续，好吗？/)
})

function source(role = 'patient') {
  const h = createHarness()
  h.storage.current_user.role = role
  h.setRequest(async options => {
    if (options.url.startsWith('/agent/context?')) return { actor_user_id: 7, patient_id: 8, assessments: [] }
    if (options.url.startsWith('/agent/runs?')) return { actor_user_id: 7, patient_id: 8, items: [] }
    if (options.url.startsWith('/agent/actions?')) return { actor_user_id: 7, patient_id: 8, mode: 'rules', items: [
      { id: 42, actor_user_id: 7, patient_id: 8, status: 'available', kind: 'continue_assessment', title: '继续本轮评估', reason: '还有实际未完成项目。',
        action_digest: 'a'.repeat(64), target: { page_key: 'assessments', params: { patient_id: 8, assessment_id: 31 } } }
    ] }
    if (options.url === '/agent/actions/42/resolve') return { action_id: 42, patient_id: 8, action_digest: 'a'.repeat(64), revalidated: true,
      target: { page_key: 'assessments', params: { patient_id: 8, assessment_id: 31 } } }
    throw new Error('unexpected synthetic route ' + options.url)
  })
  return h
}

test('ordinary user questions are displayed as answers without professional draft controls', () => {
  const { presentRun } = require('../utils/xingzai-chat')
  const row = { status: 'completed', intent: 'question', artifact: { kind: 'question', body: { reply: '你好，我是星仔。' } } }
  const answer = presentRun(row, 'patient')
  assert.equal(answer.isAnswer, true)
  assert.equal(answer.canEditDraft, false)
  assert.equal(answer.statusLabel, '星仔已回答')
  assert.equal(presentRun(row, 'researcher').canEditDraft, false)
  assert.equal(presentRun({ ...row, intent: 'plan_draft', artifact: { kind: 'plan_draft' } }, 'researcher').canEditDraft, true)
})

test('chat offers one current next step and resolves its actual original action before navigation', async () => {
  const h = source()
  try {
    const navigation = []
    wx.navigateTo = options => navigation.push(options.url)
    const page = h.load('agent-chat', { query: { patient_id: '8' } })
    await page._loadPromise
    assert.equal(page.data.moreVisible, false)
    assert.equal(page.data.nextAction.id, 42)
    assert.match(page.data.welcomeText, /星仔/)
    assert.equal(await page.openNextAction(), true)
    assert.deepEqual(navigation, ['/pages/assessments/index?patient_id=8&assessment_id=31'])
    assert.equal(h.requests.filter(row => row.method === 'POST').length, 1)
    page.onHide()
    assert.equal(page.data.nextAction, null)
    assert.deepEqual(page.data.nextActions, [])
    assert.deepEqual(page.data.visibleRuns, [])
  } finally { h.restore() }
})

test('pet interaction and help selection do not fabricate a business submission', async () => {
  const h = source()
  try {
    const page = h.load('agent-chat', { query: { patient_id: '8' } })
    await page._loadPromise
    page.petXingzai()
    assert.equal(page.data.petState, 'idle', 'the mascot owns its reaction animation; the parent preserves the business state')
    assert.ok(page.data.petText)
    page.toggleMore()
    assert.equal(page.data.moreVisible, true)
    page.showHelpPrompt({ currentTarget: { dataset: { text: '我现在应该做什么？' } } })
    assert.equal(page.data.inputValue, '我现在应该做什么？')
    assert.equal(h.requests.some(row => row.method === 'POST'), false)
  } finally { h.restore() }
})
