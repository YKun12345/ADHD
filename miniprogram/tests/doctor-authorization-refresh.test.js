const test = require('node:test')
const assert = require('node:assert/strict')
let definition, forbidden = false, reportForbidden = false
const calls = []
const navigations = []
const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true, exports: {
  request: async options => {
    calls.push(options.url)
    if (forbidden || options.url.endsWith('/ai_logs') || reportForbidden && options.url.endsWith('/report')) {
      const error = new Error('当前共享授权无效'); error.statusCode = 403; throw error
    }
    if (options.url.endsWith('/report')) return { patient_id: 8, patient_name: '合成患者' }
    if (options.url === '/doctor/my_patients') return { items: [{ patient_id: 8, patient_name: null, patient_email: null, allowed_scope: ['care'] }] }
    return { items: [{ id: 2, sender_role: 'patient', content: '合成反馈', status: 'pending' }] }
  }
} }
global.wx = { getStorageSync: key => key === 'current_user' ? { id: 3, role: 'researcher' } : 'synthetic-token',
  navigateTo: options => navigations.push(options.url) }
global.Page = value => { definition = value }
require('../pages/doctor-patient/index')

function createPage() {
  return { ...definition, data: { ...structuredClone(definition.data), patientId: 8 },
    setData(value) { Object.assign(this.data, value) } }
}
test('private AI transcript denial cannot disable authorized report, tasks or scoped message navigation', async () => {
  calls.length = 0; forbidden = false
  const page = createPage()
  await page.loadPatientData()
  assert.ok(page.data.report)
  assert.equal(page.data.messages.length, 0)
  assert.equal(page.data.tasks.length, 1)
  page.openSharedMessages(); assert.equal(navigations.at(-1), '/pages/shared-messages/index?patient_id=8')
  assert.equal(calls.some(url => url.endsWith('/messages')), false)
  assert.equal(calls.some(url => url.endsWith('/ai_logs')), false)
  assert.deepEqual(page.data.aiLogs, [])
})
test('after withdrawal a denied refresh clears previous doctor patient data', async () => {
  forbidden = false
  const page = createPage()
  page.data.report = { patientName: '旧共享资料' }; page.data.messages = [{ content: '旧私密反馈' }]
  page.data.tasks = [{ id: 4 }]; page.data.aiLogs = [{ content: '旧记录' }]
  forbidden = true
  await page.loadPatientData()
  assert.equal(page.data.report, null)
  assert.deepEqual(page.data.messages, [])
  assert.deepEqual(page.data.tasks, [])
  assert.deepEqual(page.data.aiLogs, [])
  assert.match(page.data.errorText, /授权无效/)
})
test('care-only sharing retains actual tasks and explicit message entry without fabricating a report or old message scope', async () => {
  forbidden = false; reportForbidden = true
  try {
    const page = createPage()
    await page.loadPatientData()
    assert.equal(page.data.report, null)
    assert.equal(page.data.messages.length, 0)
    assert.equal(page.data.tasks.length, 1)
    assert.equal(page.data.careAccessDenied, false)
    assert.equal(page.data.detailsAvailable, true)
    assert.equal(page.data.patientName, '共享档案 #8')
    page.openSharedMessages(); assert.equal(navigations.at(-1), '/pages/shared-messages/index?patient_id=8')
  } finally { reportForbidden = false }
})
