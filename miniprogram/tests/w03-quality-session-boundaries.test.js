const test = require('node:test')
const assert = require('node:assert/strict')
let definition, transport, pages = []
const calls = []
const storage = {}
global.wx = {
  getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value },
  removeStorageSync: key => { delete storage[key] }, showToast() {}, reLaunch() {}, navigateTo() {},
  getSystemInfoSync: () => ({ platform: 'devtools', windowWidth: 390, windowHeight: 844 }),
  request(options) { calls.push(options); transport(options) }
}
global.getCurrentPages = () => pages
global.Page = value => { definition = value }
require('../pages/assessments/index')
const { replacePatientSession } = require('../utils/session-privacy')
const session = { id: 50, patient_id: 8, status: 'active', source: 'self', version: 1,
  background: { sleep: { status: 'provided', value: 'SYNTHETIC PRIVATE A', source: 'self_report' } },
  items: [], allowed_actions: [] }

function regular(options) {
  const url = new URL(options.url).pathname
  let data
  if (url.endsWith('/identity/context')) data = { accessible_patients: [{ patient_id: 8, display_name: 'Synthetic A', patient_type: 'adult' }] }
  else if (url.endsWith('/care/assessment-templates')) data = { items: [{ id: 'adult-demo', version: 'W03-demo-1', admission_status: 'test_only', can_create_self: true, can_create_doctor_assigned: false, background_processing_allowed: true }] }
  else if (url.endsWith('/care/assessments') && options.method === 'GET') data = { items: [session] }
  else data = session
  queueMicrotask(() => options.success({ statusCode: options.method === 'POST' ? 201 : 200, data }))
}
async function page() {
  calls.length = 0
  for (const key of Object.keys(storage)) delete storage[key]
  storage.current_user = { id: 3, role: 'patient', patient_profile: { id: 8 } }
  storage.access_token = 'w03-quality-synthetic-A'
  transport = regular
  const page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values) } }
  pages = [page]
  await page.onLoad({})
  return page
}
function loginB() {
  return replacePatientSession({ access_token: 'w03-quality-synthetic-B', user: { id: 4, role: 'patient', patient_profile: { id: 9 } } }, { setLoggedIn: () => true })
}

test('quality real mobile request and session replacement scrub A and reject a late A success', async () => {
  const current = await page()
  current._apply(session)
  let respond
  transport = options => { respond = options.success }
  const pending = current.openAssessment({ currentTarget: { dataset: { id: 50 } } })
  assert.equal(typeof respond, 'function')
  assert.equal(loginB(), true)
  respond({ statusCode: 200, data: session })
  assert.equal(await pending, false)
  assert.equal(storage.access_token, 'w03-quality-synthetic-B')
  assert.equal(current.data.assessment, null)
  assert.deepEqual(current.data.sessions, [])
  assert.deepEqual(current.data.backgroundViews, [])
})

test('quality a stale mobile 401 preserves the new session and cannot restore old page data', async () => {
  const current = await page()
  current._apply(session)
  let respond
  transport = options => { respond = options.success }
  const pending = current.openAssessment({ currentTarget: { dataset: { id: 50 } } })
  loginB()
  respond({ statusCode: 401, data: { detail: 'Synthetic expired A token' } })
  assert.equal(await pending, false)
  assert.equal(storage.access_token, 'w03-quality-synthetic-B')
  assert.equal(storage.current_user.id, 4)
  assert.equal(current.data.assessment, null)
})

test('quality an old mobile attempt continuation never reads A using new B credentials', async () => {
  const current = await page()
  current._apply({ ...session, items: [{ id: 51, kind: 'scale', version: 1, protocol_id: 'project-legacy-scale-v1',
    protocol_schema_version: 1, config_digest: 'synthetic', respondent_kind: 'self', recall_window: 'P6M', allowed_actions: ['create_attempt'] }] })
  current.setRespondentConfirmation({ detail: { value: ['confirmed'] } })
  calls.length = 0
  transport = options => {
    if (options.method === 'POST') {
      // The transport succeeds under A, then the synthetic actor switches before
      // the dependent async continuation resumes. Keep the actual request code.
      options.success({ statusCode: 201, data: { id: 52 } })
      loginB()
    } else regular(options)
  }
  assert.equal(await current.createAttempt({ currentTarget: { dataset: { id: 51 } } }), false)
  assert.deepEqual(calls.filter(call => call.header.Authorization === 'Bearer w03-quality-synthetic-B').map(call => new URL(call.url).pathname), [])
  assert.equal(current.data.assessment, null)
})

test('quality a hidden mobile page stops the dependent read even when the same account token remains valid', async () => {
  const current = await page()
  current._apply({ ...session, items: [{ id: 51, kind: 'scale', version: 1, protocol_id: 'project-legacy-scale-v1',
    protocol_schema_version: 1, config_digest: 'synthetic', respondent_kind: 'self', recall_window: 'P6M', allowed_actions: ['create_attempt'] }] })
  current.setRespondentConfirmation({ detail: { value: ['confirmed'] } })
  calls.length = 0
  transport = options => {
    if (options.method === 'POST') {
      options.success({ statusCode: 201, data: { id: 52 } })
      current.onHide()
    } else regular(options)
  }
  assert.equal(await current.createAttempt({ currentTarget: { dataset: { id: 51 } } }), false)
  assert.equal(storage.access_token, 'w03-quality-synthetic-A')
  assert.deepEqual(calls.filter(call => call.method === 'GET'), [])
  assert.equal(current.data.assessment, null)
})
