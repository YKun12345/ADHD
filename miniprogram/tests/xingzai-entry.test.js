const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

test('the pet carries only the explicit current profile and round into chat', () => {
  const h = createHarness()
  try {
    let definition
    global.Component = value => { definition = value }
    const path = require.resolve('../components/ai-copilot/index')
    delete require.cache[path]; require(path)
    const navigation = []
    wx.navigateTo = options => { navigation.push(options.url); options.success(); options.complete() }
    const view = { ...definition.methods, data: { ...definition.data, patientId: 8, assessmentId: 31, cycleId: -2 }, setData(value) { Object.assign(this.data, value) } }
    view.navigateToAi('/pages/agent-chat/index?scope=general')
    assert.equal(navigation[0], '/pages/agent-chat/index?scope=general&patient_id=8&assessment_id=31')
    assert.equal(h.requests.length, 0)
  } finally { h.restore() }
})

test('doctor account menu navigates to real privacy settings and hides on page exit', async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    h.setRequest(async () => ({ items: [], total: 0 }))
    const navigation = []; wx.navigateTo = options => navigation.push(options.url)
    const page = h.load('doctor-home'); await page._loadPromise; await h.flush()
    page.toggleAccountMenu(); assert.equal(page.data.accountMenuVisible, true)
    page.openPrivacySettings()
    assert.deepEqual(navigation, ['/pages/doctor-guide-settings/index'])
    assert.equal(page.data.accountMenuVisible, false)
    page.toggleAccountMenu(); page.onHide(); assert.equal(page.data.accountMenuVisible, false)
  } finally { h.restore() }
})
