const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

function planSource(h) {
  let digest = 'a'.repeat(64)
  h.storage.current_user.role = 'researcher'
  h.setRequest(async options => {
    if (options.url === '/care/plans?patient_id=8') return { items: [] }
    if (options.url === '/care/assessments/2/plan-context') return { patient_id: 8, assessment_id: 2, actor_user_id: 7,
      calendar_today: '2026-10-17', source_report_id: 4, plan_context_digest: digest, input_digest: digest }
    throw new Error('Unexpected synthetic route ' + options.url)
  })
  delete require.cache[require.resolve('../utils/plan-page')]
  return value => { digest = value }
}

test('doctor plan text survives an assistant round trip only after fresh matching context, with hidden fields cleared', async () => {
  const h = createHarness()
  try {
    planSource(h)
    const page = h.load('doctor-plan', { query: { patient_id: '8', assessment_id: '2' } }); await page._loadPromise
    page.onTextInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '尚未保存的医生安排' } })
    page.onTextInput({ currentTarget: { dataset: { field: 'instructions' } }, detail: { value: '尚未发布的记录说明' } })
    assert.equal(page.prepareAssistantNavigation(), true)
    const reads = h.requests.length
    page.onHide(); assert.equal(page.data.title, ''); assert.equal(page.data.instructions, '')
    assert.equal(await page.onShow(), true)
    assert.ok(h.requests.length > reads)
    assert.equal(page.data.title, '尚未保存的医生安排'); assert.equal(page.data.instructions, '尚未发布的记录说明')
    assert.match(page.data.statusText, /未保存/)
    assert.equal(h.requests.some(row => row.method === 'POST'), false)
    assert.equal(h.writes.some(([key]) => key.includes('draft')), false)
  } finally { h.restore() }
})

test('a changed clinical input cannot receive the previous form text automatically', async () => {
  const h = createHarness()
  try {
    const changeDigest = planSource(h)
    const page = h.load('doctor-plan', { query: { patient_id: '8', assessment_id: '2' } }); await page._loadPromise
    page.onTextInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '基于旧材料的文字' } })
    assert.equal(page.prepareAssistantNavigation(), true); page.onHide(); changeDigest('b'.repeat(64))
    await page.onShow()
    assert.notEqual(page.data.title, '基于旧材料的文字')
    assert.match(page.data.statusText, /变化|重新核对/)
  } finally { h.restore() }
})

test('backgrounding or changing the actual session destroys the temporary assistant-return draft', async () => {
  const h = createHarness()
  try {
    planSource(h)
    const page = h.load('doctor-plan', { query: { patient_id: '8', assessment_id: '2' } }); await page._loadPromise
    page.onTextInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '私人未发布文字' } })
    page.prepareAssistantNavigation(); page.onHide()
    require('../utils/assistant-draft-guard').clearAssistantDrafts()
    await page.onShow(); assert.notEqual(page.data.title, '私人未发布文字')
    page.onTextInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '另一次私人文字' } })
    page.prepareAssistantNavigation(); page.onHide()
    h.storage.access_token = 'different-session'
    assert.equal(await page.onShow(), false); assert.equal(page.data.title, '')
  } finally { h.restore() }
})

test('session ending clears the private form context even when the original page has no session-ended handler', async () => {
  const h = createHarness()
  try {
    planSource(h)
    const page = h.load('doctor-plan', { query: { patient_id: '8', assessment_id: '2' } }); await page._loadPromise
    page.onTextInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '退出后不能恢复的私人文字' } })
    assert.ok(page._context)
    page.prepareAssistantNavigation(); page.onPatientSessionEnded()
    assert.equal(page._context, null); assert.equal(page.data.title, ''); assert.equal(page._ended, true)
    assert.equal(await page.onShow(), false)
    assert.equal(page.data.title, '')
  } finally { h.restore() }
})

test('current-page help stays on the form; opening chat during a timed task does not interrupt it', () => {
  const h = createHarness(), originalPages = global.getCurrentPages
  try {
    let definition
    global.Component = value => { definition = value }
    const file = require.resolve('../components/ai-copilot/index'); delete require.cache[file]; require(file)
    const navigation = [], toasts = []
    wx.navigateTo = options => navigation.push(options.url); wx.showToast = value => toasts.push(value.title)
    const form = { data: { title: '仍在当前表单' } }; global.getCurrentPages = () => [form]
    const view = { ...definition.methods, data: { ...definition.data, pageKey: 'doctor-plan' }, setData(value) { Object.assign(this.data, value) } }
    definition.lifetimes.attached.call(view)
    view.openPageHelp()
    assert.equal(navigation.length, 0); assert.equal(form.data.title, '仍在当前表单')
    assert.equal(view.data.inlineHelpVisible, true)
    assert.ok(view.data.helpSteps.some(row => /发布|确认/.test(row)))
    form.data.running = true
    view.openFreeQuestion(); assert.equal(navigation.length, 0); assert.ok(toasts.length)
  } finally { global.getCurrentPages = originalPages; h.restore() }
})
