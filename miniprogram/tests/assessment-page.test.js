const test = require('node:test')
const assert = require('node:assert/strict')
const requests = []
const storage = { access_token: 'synthetic-assessment-token', current_user: { id: 3, role: 'patient', patient_profile: { id: 8 } } }
let definition, transport
const navigations = []
const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true, exports: {
  request: options => { requests.push(options); return transport(options) }
} }
global.wx = { getStorageSync: key => storage[key], showToast() {}, reLaunch() {}, navigateTo(value) { navigations.push(value.url) },
  getSystemInfoSync: () => ({ platform: 'devtools', model: 'synthetic', windowWidth: 390, windowHeight: 844 }) }
global.Page = value => { definition = value }
const active = { id: 42, patient_id: 8, source: 'self', responsible_doctor_id: null, status: 'active', version: 1,
  items: [], allowed_actions: [], demonstration_only: true }
function createPage() {
  require('../pages/assessments/index')
  return { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values) } }
}
function regularTransport(options) {
  if (options.url === '/identity/context') return Promise.resolve({ accessible_patients: [{ patient_id: 8, display_name: '合成档案', patient_type: 'adult' }] })
  if (options.url.startsWith('/care/assessment-templates')) return Promise.resolve({ patient_id: 8,
    items: [{ id: 'adult-demo', version: 'W03-demo-1', title: '合成模板', admission_status: 'test_only', can_create: true, can_create_self: true, can_create_doctor_assigned: false, demonstration_only: true, items: [] }] })
  if (options.url.startsWith('/care/assessments?')) return Promise.resolve({ items: [] })
  if (options.method === 'POST') return Promise.resolve(active)
  throw new Error('Unexpected request ' + options.url)
}

test('self creation retains skipped background and the actual server state without a fake doctor or completed project', async () => {
  requests.length = 0; transport = regularTransport
  const page = createPage()
  await page.onLoad({})
  await page.createAssessment()
  const write = requests.find(item => item.method === 'POST')
  assert.equal(write.url, '/care/patient/assessments')
  assert.equal(write.data.patient_id, 8)
  assert.equal(write.data.template_id, 'adult-demo')
  assert.equal(write.data.template_version, 'W03-demo-1')
  assert.ok(Object.values(write.data.background).every(field => field.status === 'skipped' && field.value === null))
  assert.equal('responsible_doctor_id' in write.data, false)
  assert.equal('status' in write.data, false)
  assert.equal(page.data.assessment.status, 'active')
  assert.equal(page.data.assessment.responsible_doctor_id, null)
})

test('blocked formal templates cannot produce a creation request or success state', async () => {
  requests.length = 0
  transport = options => options.url.startsWith('/care/assessment-templates')
    ? Promise.resolve({ patient_id: 8, items: [{ id: 'adult-demo', version: 'W03-demo-1', admission_status: 'blocked' }], blockers: ['license_not_verified'] })
    : regularTransport(options)
  const page = createPage()
  await page.onLoad({}); await page.createAssessment()
  assert.equal(requests.some(item => item.method === 'POST'), false)
  assert.equal(page.data.assessment, null)
  assert.ok(page.data.errorText || page.data.admissionText)
})

test('regular server reference assessments can be created with their actual permission flags', async () => {
  requests.length = 0
  transport = options => options.url.startsWith('/care/assessment-templates')
    ? Promise.resolve({ patient_id: 8, items: [{ id: 'adult-demo', version: 'W03-demo-1',
      title: '成人参考评估', admission_status: 'reference_use', can_create_self: true,
      can_create_doctor_assigned: false, usage_notice: '参考评估，不替代医生诊断。' }] })
    : regularTransport(options)
  const page = createPage()
  await page.onLoad({})
  assert.equal(page.data.canCreate, true)
  assert.match(page.data.admissionText, /参考评估/)
  await page.createAssessment()
  assert.equal(requests.filter(item => item.method === 'POST').length, 1)
})

test('a late creation acknowledgement after page hide cannot restore previous assessment details', async () => {
  transport = regularTransport
  const page = createPage(); await page.onLoad({})
  let acknowledge
  transport = options => options.method === 'POST' ? new Promise(resolve => { acknowledge = resolve }) : regularTransport(options)
  const pending = page.createAssessment()
  await Promise.resolve()
  assert.equal(typeof acknowledge, 'function')
  page.onHide(); acknowledge(active); await pending
  assert.equal(page.data.assessment, null)
  assert.deepEqual(page.data.sessions, [])
})

test('mobile cognitive attempt separates execution platform from the device environment', async () => {
  requests.length = 0; transport = options => options.url === '/care/assessments/42' ? Promise.resolve(active) : regularTransport(options)
  const page = createPage(); await page.onLoad({})
  page._apply({ ...active, items: [{ id: 71, kind: 'cognitive', version: 1, protocol_id: 'continuous-mobile-v4',
    protocol_schema_version: 6, config_digest: 'synthetic-digest', allowed_actions: ['create_attempt'] }] })
  page.setRespondentConfirmation({ detail: { value: ['confirmed'] } })
  await page.createAttempt({ currentTarget: { dataset: { id: 71 } } })
  const write = requests.find(item => item.url.endsWith('/attempts'))
  assert.equal(write.data.device.platform, 'miniprogram')
  assert.equal(write.data.device.environment, 'devtools')
  assert.equal(write.data.device.device_type, 'simulator')
  assert.equal(write.data.input.method, 'unknown')
  assert.equal(write.data.timing.calibrated, false)
})

test('a creation hint without background authority permits skipping but cannot collect provided background', async () => {
  requests.length = 0; transport = regularTransport
  const page = createPage(); await page.onLoad({})
  assert.equal(page.data.backgroundProcessingAllowed, false)
  page.setBackgroundStatus({ currentTarget: { dataset: { index: 0 } }, detail: { value: 'provided' } })
  page.setBackgroundValue({ currentTarget: { dataset: { index: 0 } }, detail: { value: 'private synthetic history' } })
  assert.equal(page.data.backgroundFields[0].status, 'skipped')
  assert.equal(page.data.backgroundFields[0].value, '')
  await page.createAssessment()
  assert.ok(Object.values(requests.find(item => item.method === 'POST').data.background).every(field => field.value === null))
})

test('self creation cannot borrow a doctor-only creation hint', async () => {
  requests.length = 0
  transport = options => options.url.startsWith('/care/assessment-templates') ? Promise.resolve({ items: [{
    id: 'adult-demo', version: 'W03-demo-1', admission_status: 'test_only', can_create: true,
    can_create_self: false, can_create_doctor_assigned: true
  }] }) : regularTransport(options)
  const page = createPage(); await page.onLoad({}); await page.createAssessment()
  assert.equal(page.data.canCreate, false)
  assert.equal(requests.some(item => item.method === 'POST'), false)
})

test('doctor draft publication is offered only when the server still grants that action', () => {
  const page = createPage(); page.data.patientId = 8; page.data.role = 'researcher'
  page._apply({ ...active, source: 'doctor_assigned', status: 'draft', allowed_actions: [] })
  assert.equal(page.data.assessment.canPublish, false)
  page._apply({ ...active, source: 'doctor_assigned', status: 'draft', allowed_actions: ['publish'] })
  assert.equal(page.data.assessment.canPublish, true)
  const markup = require('node:fs').readFileSync(require('node:path').join(__dirname, '../pages/assessments/index.wxml'), 'utf8')
  assert.match(markup, /wx:if="\{\{assessment\.canPublish\}\}"[^>]*bindtap="publishAssessment"/)
})

test('a newly committed server attempt opens its actual execution page with fixed assessment/item/attempt IDs', async () => {
  requests.length = 0; navigations.length = 0
  const item = { id: 71, patient_id: 8, assessment_id: 42, kind: 'cognitive', instrument: 'flanker', version: 1,
    protocol_id: 'continuous-mobile-v4', protocol_schema_version: 6, config_digest: 'synthetic-digest', allowed_actions: ['create_attempt'] }
  const attempt = { id: 53, assessment_id: 42, assessment_item_id: 71, patient_id: 8, run_id: 'server-run' }
  transport = options => options.url.endsWith('/attempts') ? Promise.resolve(attempt)
    : options.url === '/care/assessments/42' ? Promise.resolve({ ...active, items: [{ ...item, attempts: [attempt] }] }) : regularTransport(options)
  const page = createPage(); await page.onLoad({}); page._apply({ ...active, items: [item] })
  page.setRespondentConfirmation({ detail: { value: ['confirmed'] } })
  await page.createAttempt({ currentTarget: { dataset: { id: 71 } } })
  assert.deepEqual(navigations, ['/pages/flanker/index?assessment_id=42&item_id=71&attempt_id=53'])
})

test('published repeat passes its exact report and continues the actual successor without a second POST', async () => {
  requests.length = 0; navigations.length = 0
  const item = { id: 71, patient_id: 8, assessment_id: 42, kind: 'cognitive', instrument: 'flanker', version: 3,
    protocol_id: 'continuous-mobile-v4', protocol_schema_version: 6, config_digest: 'synthetic-digest', allowed_actions: ['create_attempt'],
    repeat_request: { report_id: 91, source_attempt_id: 52, reason: '核对执行环境', available: true, continuing_attempt_id: null } }
  const attempt = { id: 53, assessment_id: 42, assessment_item_id: 71, patient_id: 8, run_id: 'new-repeat-run', execution_status: 'in_progress' }
  transport = options => options.url.endsWith('/attempts') ? Promise.resolve(attempt) : options.url === '/care/assessments/42'
    ? Promise.resolve({ ...active, source: 'doctor_assigned', status: 'under_review', items: [{ ...item, allowed_actions: [], attempts: [attempt],
      repeat_request: { ...item.repeat_request, available: false, continuing_attempt_id: 53 } }] }) : regularTransport(options)
  const page = createPage(); await page.onLoad({}); page._apply({ ...active, source: 'doctor_assigned', status: 'under_review', items: [item] })
  page.setRespondentConfirmation({ detail: { value: ['confirmed'] } })
  assert.equal(await page.createAttempt({ currentTarget: { dataset: { id: 71 } } }), true)
  assert.equal(requests.find(row => row.url.endsWith('/attempts')).data.repeat_report_id, 91)
  const postCount = requests.filter(row => row.method === 'POST').length
  assert.equal(page.resumeAttempt({ currentTarget: { dataset: { id: 71 } } }), true)
  assert.equal(requests.filter(row => row.method === 'POST').length, postCount)
  assert.deepEqual(navigations, Array(2).fill('/pages/flanker/index?assessment_id=42&item_id=71&attempt_id=53'))
  page.onHide(); assert.equal(page.resumeAttempt({ currentTarget: { dataset: { id: 71 } } }), false)
})
