const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function fixture() {
  let definition
  let current = true
  const calls = { requests: [], logins: [], subscriptions: [], navigation: [] }
  const state = { bound: true, enabled: true, binding_revision: 1, available_permissions: 1,
    template_ready: true, binding_ready: true, delivery_enabled: true, blockers: [], items: [] }
  let respond = async options => options.url === '/notifications/permission-requests'
    ? { permission_id: 'synthetic-permission', template_id: 'synthetic-template' } : { ...state }
  const wx = { login: options => calls.logins.push(options), requestSubscribeMessage: options => calls.subscriptions.push(options),
    showToast() {}, navigateTo: options => calls.navigation.push(options.url) }
  const filename = path.resolve(__dirname, '../pages/notifications/index.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { Page: value => { definition = value }, wx,
    require(id) {
      if (id.endsWith('/request')) return { request: options => { calls.requests.push(options); return respond(options) } }
      if (id.endsWith('/role-session')) return { hasValidAnySession: () => current }
      if (id.endsWith('/session-privacy')) return { capturePatientSessionLease: () => ({}),
        isPatientSessionLeaseCurrent: () => current, reLaunchSafely() {} }
      throw new Error(id)
    } }, { filename })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch) { Object.assign(this.data, patch) } }
  return { page, calls, state, changeSession() { current = false }, respond(fn) { respond = fn } }
}

test('loading notification settings never opens the subscription prompt', async () => {
  const f = fixture(); f.page.onLoad(); await f.page.onShow()
  assert.equal(f.calls.subscriptions.length, 0)
  f.page.subscribeOnce()
  assert.equal(f.calls.subscriptions.length, 1)
  assert.equal(f.calls.subscriptions[0].tmplIds[0], 'synthetic-template')
})

test('disabled or unconfigured notifications explain availability without requesting permission', async () => {
  const f = fixture(); f.state.delivery_enabled = false; f.state.binding_ready = false
  f.state.blockers = ['missing_app_secret', 'template_fields_not_configured', 'delivery_disabled']
  f.page.onLoad(); await f.page.onShow(); f.page.subscribeOnce(); f.page.bindWechat()
  assert.equal(f.calls.requests.some(row => row.url === '/notifications/permission-requests'), false)
  assert.equal(f.calls.logins.length, 0)
  assert.equal(f.calls.subscriptions.length, 0)
  assert.match(f.page.data.blockerText, /尚未开通.*照常使用/)
  assert.doesNotMatch(f.page.data.blockerText, /凭据|字段|AppSecret|thing/)
})

test('each explicit subscription click records its own one-time platform result', async () => {
  const f = fixture(); f.page.onLoad(); await f.page.onShow(); f.page.subscribeOnce()
  await f.calls.subscriptions[0].success({ 'synthetic-template': 'accept' })
  const recorded = f.calls.requests.find(options => /\/result$/.test(options.url))
  assert.equal(recorded.data.result, 'accept')
  assert.equal(recorded.url, '/notifications/permission-requests/synthetic-permission/result')
})

test('hide/session change prevents late wx.login from binding a new account', async () => {
  for (const boundary of ['hide', 'session']) {
    const f = fixture(); f.page.onLoad(); await f.page.onShow(); f.page.bindWechat()
    if (boundary === 'hide') f.page.onHide()
    else f.changeSession()
    await f.calls.logins[0].success({ code: 'synthetic-code' })
    assert.equal(f.calls.requests.some(options => options.url === '/notifications/wechat-bind'), false)
    assert.equal(f.page.data.items.length, 0)
  }
})

test('late subscription result after hide or account switch cannot add a permit', async () => {
  const f = fixture(); f.page.onLoad(); await f.page.onShow(); f.page.subscribeOnce(); f.changeSession()
  await f.calls.subscriptions[0].success({ 'synthetic-template': 'accept' })
  assert.equal(f.calls.requests.some(options => /\/result$/.test(options.url)), false)
})

test('notification clicks resolve own record then construct only known actual routes', async () => {
  const f = fixture(); f.state.items = [{ id: 'synthetic-notification', title: '合成提醒', status: 'pending' }]
  f.page.onLoad(); await f.page.onShow()
  f.respond(async () => ({ notification_id: 'synthetic-notification', page: '/pages/shared-messages/index', patient_id: 71, relationship_id: 22 }))
  await f.page.openBusiness({ currentTarget: { dataset: { id: 'unknown', page: 'https://evil.example' } } })
  await f.page.openBusiness({ currentTarget: { dataset: { id: 'synthetic-notification' } } })
  assert.deepEqual(f.calls.navigation, ['/pages/shared-messages/index?patient_id=71&relationship_id=22'])
  assert.ok(f.calls.requests.some(row => row.url === '/notifications/synthetic-notification/resolve'))
})

test('invalid or late resolved routes never navigate', async () => {
  for (const late of [false, true]) {
    const f = fixture(); f.state.items = [{ id: 'synthetic-notification', title: '合成提醒', status: 'pending' }]
    f.page.onLoad(); await f.page.onShow()
    f.respond(async () => {
      if (late) f.changeSession()
      return { notification_id: 'synthetic-notification', page: late ? '/pages/care-reports/index' : 'https://evil.example', patient_id: 71, assessment_id: 3 }
    })
    await f.page.openBusiness({ currentTarget: { dataset: { id: 'synthetic-notification' } } })
    assert.equal(f.calls.navigation.length, 0)
  }
})
