const assert = require('node:assert/strict')
const { TRACKING_LOGS_KEY, TRACKING_PENDING_KEY } = require('../utils/tracking-data')

const calls = { requests: [], writes: [], toasts: [], modals: [], back: [], navigateTo: [] }
let storage = {}
let requestImplementation = async () => ({ id: 1 })
let pageDefinition

const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true, exports: {
  request(options) { calls.requests.push(options); return requestImplementation(options) }
} }

global.wx = {
  getStorageSync(key) { return storage[key] },
  setStorageSync(key, value) { storage[key] = value; calls.writes.push([key, value]) },
  showToast(options) { calls.toasts.push(options) },
  showModal(options) { calls.modals.push(options); options.success({ confirm: true }) },
  navigateTo(options) { calls.navigateTo.push(options) },
  navigateBack(options) { calls.back.push(options) }
}
global.Page = (definition) => { pageDefinition = definition }
require('../pages/tracking/index')

function createPage() {
  return { ...pageDefinition, data: JSON.parse(JSON.stringify(pageDefinition.data)), setData(patch) { this.data = { ...this.data, ...patch } } }
}
function reset() {
  calls.requests = []; calls.writes = []; calls.toasts = []; calls.modals = []; calls.back = []; calls.navigateTo = []
  storage = { access_token: 'test-token', current_user: { full_name: '追踪患者' }, patient_dashboard_cache: { currentDay: 3, completedDays: [1, 2] } }
  requestImplementation = async () => ({ id: 1 })
}

async function run() {
  reset()
  const page = createPage()
  page.onLoad()
  assert.equal(page.data.patientName, '追踪患者')
  assert.equal(page.data.dayIndex, 3)
  assert.equal(page.data.completedCount, 0)

  page.selectRating({ currentTarget: { dataset: { field: 'moodTag', value: 4 } } })
  page.selectRating({ currentTarget: { dataset: { field: 'attentionRating', value: 3 } } })
  page.selectSleep({ currentTarget: { dataset: { value: 'good' } } })
  page.onFieldInput({ currentTarget: { dataset: { field: 'focusMinutes' } }, detail: { value: '80' } })
  page.toggleMedication()
  page.onFieldInput({ currentTarget: { dataset: { field: 'medicationDosage' } }, detail: { value: '遵医嘱一次' } })
  page.onFieldInput({ currentTarget: { dataset: { field: 'note' } }, detail: { value: '状态稳定' } })
  await page.submitTracking()
  assert.equal(calls.requests.length, 1)
  assert.equal(calls.requests[0].url, '/patient/submit_daily_log')
  assert.equal(storage[TRACKING_LOGS_KEY][0].sync_status, 'synced')
  assert.deepEqual(storage.patient_dashboard_cache.completedDays, [1, 2, 3])
  assert.equal(page.data.saveStatus, '已同步')
  assert.equal(page.data.submitting, false)

  reset()
  requestImplementation = async () => { throw new Error('offline') }
  const offline = createPage(); offline.onLoad()
  offline.setData({ moodTag: 3, attentionRating: 4, focusMinutes: '40', sleepQuality: 'fair' })
  await offline.submitTracking()
  assert.equal(offline.data.saveStatus, '已保存本机，待同步')
  assert.ok(storage[TRACKING_PENDING_KEY]['3'])
  assert.equal(storage[TRACKING_LOGS_KEY][0].sync_status, 'pending')

  reset()
  const invalid = createPage(); invalid.onLoad(); await invalid.submitTracking()
  assert.equal(calls.requests.length, 0)
  assert.equal(calls.toasts.at(-1).title, '请选择今日情绪')

  reset()
  const demo = createPage(); demo.onLoad(); demo.generateDemoData()
  assert.equal(calls.modals.length, 1)
  assert.equal(storage[TRACKING_LOGS_KEY].length, 14)
  assert.equal(demo.data.completedCount, 14)
  assert.equal(demo.data.demoMode, true)
  assert.equal(calls.requests.length, 0)

  demo.goBack()
  assert.deepEqual(calls.back, [{ delta: 1 }])
  demo.openTrend()
  assert.deepEqual(calls.navigateTo, [{ url: '/pages/tracking-trend/index' }])
  console.log('每日追踪页面控制逻辑测试全部通过')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
