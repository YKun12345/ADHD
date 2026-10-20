const test = require('node:test')
const assert = require('node:assert/strict')

let storage, respond, definition, modal
const calls = []
const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true,
  exports: { request: options => { calls.push(options); return respond(options) } }
}
global.wx = {
  getStorageSync: key => storage[key],
  showModal: options => { modal(options) }
}
global.Component = value => { definition = value }
require('../components/authorization-panel/index')

function createComponent(role = 'patient') {
  storage = { access_token: 'synthetic-A', current_user: { id: 7, role } }
  calls.length = 0
  modal = options => options.success({ confirm: true })
  const component = { ...definition.methods, properties: { role }, data: structuredClone(definition.data),
    setData(value) { Object.assign(this.data, value) } }
  return component
}
function fixture(options = {}) {
  return async request => {
    if (request.url === '/identity/context') return {
      user_id: 7, accessible_patients: [{ patient_id: 3, display_name: '合成人', access_kind: 'self' }],
      guardian_relationships: [], ...options.context
    }
    if (request.url === '/care/relationships') return { items: options.relationships || [] }
    if (request.url.startsWith('/patient/consents?')) return { items: options.consents || [] }
    if (request.method === 'POST' && options.post) return options.post(request)
    throw new Error('unexpected request ' + request.url)
  }
}

test('pending guardian sees own confirmation entry without accessing child data', async () => {
  const component = createComponent()
  respond = fixture({ context: { accessible_patients: [], guardian_relationships: [{ id: 8, status: 'pending' }] } })
  await component.reloadAuthorization()
  assert.equal(component.data.patientId, null)
  assert.equal(component.data.guardians[0].statusLabel, '待本人确认')
  assert.equal(component.data.guardians[0].canConfirm, true)
  assert.equal(calls.some(item => item.url.startsWith('/patient/consents')), false)
  assert.equal(component.grantExternalAi(), false)
})

test('legacy guardian confirmation posts the actual relationship revision and age', async () => {
  const component=createComponent()
  const row={id:8,status:'pending',revision:3,guardian_age:35}
  respond=fixture({context:{accessible_patients:[],guardian_relationships:[row]},post:request=>{
    assert.equal(request.url,'/identity/guardians/8/confirm-relationship')
    assert.deepEqual(request.data,{expected_revision:3,confirmed:true,guardian_age:35,declaration_version:'guardian-self-declaration-2026-10-19'})
    row.status='confirmed';return {...row}
  }})
  await component.reloadAuthorization()
  assert.equal(await component.confirmGuardianRelationship({currentTarget:{dataset:{id:8}}}),true)
  assert.equal(component.data.guardians[0].statusLabel,'监护人已确认')
})

for (const purpose of ['external_ai', 'research']) test(`${purpose} withdrawal sends the server revision and reloads acknowledged state`, async () => {
  const component = createComponent()
  const consent = { id: 12, purpose, status: 'active', revision: 4, ...(purpose === 'research' ? { project_id: 6 } : {}) }
  respond = fixture({ consents: [consent], post: request => {
    assert.equal(request.url, '/patient/consents/12/withdraw')
    assert.deepEqual(request.data, { expected_revision: 4 })
    consent.status = 'withdrawn'; consent.revision = 5
    return { ...consent }
  } })
  await component.reloadAuthorization()
  assert.equal(component.data.consents[0].purpose, purpose)
  if (purpose === 'research') {
    assert.equal(component.data.consents[0].project_id, 6)
    assert.equal(component.data.consents[0].purposeLabel, '具体研究')
    assert.equal(component.data.consents[0].canWithdraw, true)
  }
  assert.equal(await component.withdrawConsent({ currentTarget: { dataset: { id: '12' } } }), true)
  assert.equal(component.data.consents[0].canWithdraw, false)
  assert.equal(component.data.consents[0].revision, 5)
})

test('revision conflict is visible and never presented as withdrawn', async () => {
  const component = createComponent()
  respond = fixture({ consents: [{ id: 12, purpose: 'external_ai', status: 'active', revision: 4 }],
    post: () => { throw new Error('授权版本已改变，请刷新') } })
  await component.reloadAuthorization()
  assert.equal(await component.withdrawConsent({ currentTarget: { dataset: { id: '12' } } }), false)
  assert.match(component.data.errorText, /版本已改变/)
  assert.equal(component.data.statusText, '')
  assert.equal(component.data.consents[0].status, 'active')
})

test('switching account during a confirmation cannot send the old grant using the new token', async () => {
  const component = createComponent()
  respond = fixture()
  await component.reloadAuthorization()
  modal = options => { storage.access_token = 'synthetic-B'; options.success({ confirm: true }) }
  assert.equal(await component.grantExternalAi(), false)
  assert.equal(calls.filter(item => item.method === 'POST').length, 0)
})

test('late old context cannot repopulate authorization details after account change', async () => {
  const component = createComponent()
  let finish
  respond = options => options.url === '/identity/context' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ items: [] })
  const loading = component.reloadAuthorization()
  storage.access_token = 'synthetic-B'
  finish({ user_id: 7, accessible_patients: [{ patient_id: 3, display_name: 'A private patient' }] })
  assert.equal(await loading, false)
  assert.deepEqual(component.data.patients, [])
  assert.equal(component.data.patientId, null)
})

test('inviter cannot accept its own pending invitation', async () => {
  const component = createComponent('researcher')
  respond = fixture({ relationships: [{ id: 9, status: 'pending', initiator_user_id: 7, revision: 1, scope: ['care'] }] })
  await component.reloadAuthorization()
  assert.equal(component.acceptRelationship({ currentTarget: { dataset: { id: '9' } } }), false)
  assert.equal(calls.filter(item => item.method === 'POST').length, 0)
})

test('stored active without effective access is denied while pending remains confirmable', async () => {
  const component = createComponent()
  respond = fixture({ relationships: [
    { id: 9, status: 'active', effective_access: false, initiator_user_id: 8, revision: 2, scope: ['care'] },
    { id: 10, status: 'pending', effective_access: false, initiator_user_id: 8, revision: 1, scope: ['care'] }
  ] })
  await component.reloadAuthorization()
  assert.equal(component.data.relationships[0].statusLabel, '授权校验未通过')
  assert.equal(component.data.relationships[1].canAccept, true)
})
