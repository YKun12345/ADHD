const assert = require('node:assert/strict')
const { SCALE_LATEST_RESULT_KEY } = require('../utils/report-data')
const { LATEST_RESULTS_KEY } = require('../utils/cognitive-results')
const { TRACKING_LOGS_KEY } = require('../utils/tracking-data')

const calls = { requests: [], navigateTo: [], navigateBack: [] }
let storage = {}
let requestImplementation = async () => ({})
let pageDefinition

const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true, exports: {
  request(options) { calls.requests.push(options); return requestImplementation(options) },
  isPatientSessionError(error) {
    return Boolean(error) && (
      error.code === 'SESSION_CHANGED' || error.statusCode === 401
    )
  }
} }

global.wx = {
  getStorageSync(key) { return storage[key] },
  navigateTo(options) { calls.navigateTo.push(options) },
  navigateBack(options) { calls.navigateBack.push(options) }
}
global.Page = (definition) => { pageDefinition = definition }
require('../pages/care-pathway/index.js')

function createPage() {
  return {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(patch) { this.data = { ...this.data, ...patch } }
  }
}

function scaleResult() {
  return {
    scale_type: 'ASRS', respondent_type: 'self', total_score: 28,
    risk_level: 'medium', summary: '摘要', recommendations: [],
    radar_scores: {
      attention_control: 12, organization: 10, task_activation: 11,
      hyperactivity: 8, impulsivity: 9
    }
  }
}

function reset() {
  calls.requests = []; calls.navigateTo = []; calls.navigateBack = []
  storage = {
    access_token: 'test-token',
    current_user: {
      id: 1,
      role: 'patient',
      full_name: '路径测试患者',
      patient_profile: { patient_type: 'adult' }
    }
  }
  requestImplementation = async () => ({})
}

async function run() {
  reset()
  const localPage = createPage()
  localPage.onLoad()
  assert.equal(localPage.data.patientName, '路径测试患者')
  assert.equal(localPage.data.completedCount, 1)
  assert.equal(localPage.data.currentStep.id, 'scale')
  assert.equal(localPage.data.sourceLabel, '本地结果')

  requestImplementation = async () => ({
    patient_name: '路径测试患者',
    patient_type: 'adult',
    latest_scale: scaleResult(),
    cognitive_profile: {
      latest_tests: [
        { test_type: 'reaction', test_name: 'Go/No-Go', key_metric: '正确率 80%' },
        { test_type: 'stroop', test_name: 'Stroop', key_metric: '正确率 75%' }
      ]
    },
    tracking_summary: {
      completed_count: 14,
      completed_days: Array.from({ length: 14 }, (_, index) => index + 1)
    }
  })
  await localPage.onShow()
  assert.deepEqual(calls.requests, [{
    url: '/patient/comprehensive_report',
    method: 'GET'
  }])
  assert.equal(localPage.data.completedCount, 5)
  assert.equal(localPage.data.percent, 100)
  assert.equal(localPage.data.complete, true)
  assert.equal(localPage.data.currentStep, null)
  assert.equal(localPage.data.sourceLabel, '已同步')
  assert.equal(localPage.data.loading, false)

  reset()
  storage[SCALE_LATEST_RESULT_KEY] = scaleResult()
  storage[LATEST_RESULTS_KEY] = {
    reaction: {
      test_type: 'reaction',
      result_json: { raw_result: { accuracy: 80 } }
    }
  }
  storage[TRACKING_LOGS_KEY] = [{ day_index: 1, attention_rating: 3 }]
  requestImplementation = async () => { throw new Error('offline') }
  const offlinePage = createPage()
  offlinePage.onLoad()
  await offlinePage.onShow()
  assert.equal(offlinePage.data.completedCount, 2)
  assert.equal(offlinePage.data.steps[2].status, 'partial')
  assert.equal(offlinePage.data.steps[3].status, 'partial')
  assert.equal(offlinePage.data.steps[4].status, 'partial')
  assert.equal(offlinePage.data.statusMessage, '暂时无法同步，当前展示本地路径')
  assert.equal(offlinePage.data.loading, false)

  reset()
  let releaseRequest
  requestImplementation = () => new Promise((resolve) => { releaseRequest = resolve })
  const guardedPage = createPage(); guardedPage.onLoad()
  const first = guardedPage.onShow(); const second = guardedPage.onShow()
  assert.equal(calls.requests.length, 1)
  releaseRequest({})
  await Promise.all([first, second])

  reset()
  let rejectStaleRequest
  requestImplementation = () => new Promise((resolve, reject) => {
    rejectStaleRequest = reject
  })
  const staleSessionPage = createPage()
  staleSessionPage.onLoad()
  const staleRefresh = staleSessionPage.onShow()
  staleSessionPage._localReport = null
  staleSessionPage.setData({
    patientName: '',
    steps: [],
    statusMessage: '',
    loading: false
  })
  rejectStaleRequest(Object.assign(new Error('expired'), {
    statusCode: 401
  }))
  await staleRefresh
  assert.equal(staleSessionPage.data.patientName, '')
  assert.deepEqual(staleSessionPage.data.steps, [])
  assert.equal(staleSessionPage._localReport, null)
  assert.equal(typeof staleSessionPage.onPatientSessionEnded, 'function')
  staleSessionPage._localReport = { patientName: 'old patient' }
  staleSessionPage.onPatientSessionEnded()
  assert.equal(staleSessionPage._localReport, null)

  guardedPage.openStep({ currentTarget: { dataset: { step: 'scale' } } })
  guardedPage.openStep({ currentTarget: { dataset: { step: 'cognitive' } } })
  guardedPage.openStep({ currentTarget: { dataset: { step: 'tracking' } } })
  guardedPage.openStep({ currentTarget: { dataset: { step: 'report' } } })
  guardedPage.openStep({ currentTarget: { dataset: { step: 'unknown' } } })
  guardedPage.openAi()
  guardedPage.openEducation()
  assert.deepEqual(calls.navigateTo, [
    { url: '/pages/scale/index' },
    { url: '/pages/cognitive-center/index' },
    { url: '/pages/tracking/index' },
    { url: '/pages/report/index' },
    { url: '/pages/ai-chat/index' },
    { url: '/pages/education/index' }
  ])
  guardedPage.goBack()
  assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

  console.log('临床路径页面控制逻辑测试全部通过')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
