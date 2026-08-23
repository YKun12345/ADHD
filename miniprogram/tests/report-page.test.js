const assert = require('node:assert/strict')

const {
  SCALE_LATEST_RESULT_KEY
} = require('../utils/report-data')
const {
  LATEST_RESULTS_KEY
} = require('../utils/cognitive-results')
const {
  TRACKING_LOGS_KEY
} = require('../utils/tracking-data')

const calls = {
  requests: [],
  navigateTo: [],
  navigateBack: [],
  canvas: []
}
let storage = {}
let requestImplementation = async () => ({})
let pageDefinition

const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = {
  id: requestPath,
  filename: requestPath,
  loaded: true,
  exports: {
    request(options) {
      calls.requests.push(options)
      return requestImplementation(options)
    }
  }
}

function canvasContext(canvasId) {
  return new Proxy({}, {
    get(_, method) {
      return (...args) => {
        calls.canvas.push([canvasId, method, ...args])
      }
    }
  })
}

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  navigateTo(options) {
    calls.navigateTo.push(options)
  },
  navigateBack(options) {
    calls.navigateBack.push(options)
  },
  createCanvasContext(canvasId) {
    calls.canvas.push([canvasId, 'create'])
    return canvasContext(canvasId)
  },
  nextTick(callback) {
    callback()
  }
}

global.Page = (definition) => {
  pageDefinition = definition
}

require('../pages/report/index.js')

function createPage() {
  return {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(patch, callback) {
      this.data = {
        ...this.data,
        ...patch
      }
      if (callback) callback()
    }
  }
}

function scaleResult(totalScore = 28) {
  return {
    id: 1,
    scale_type: 'ASRS',
    respondent_type: 'self',
    total_score: totalScore,
    risk_level: 'medium',
    radar_scores: {
      attention_control: 12,
      organization: 10,
      task_activation: 11,
      hyperactivity: 8,
      impulsivity: 9
    },
    sub_scores: {},
    summary: '量表摘要',
    recommendations: ['继续完成追踪'],
    created_at: '2026-08-21T08:00:00.000Z'
  }
}

function cognitivePayload(type, accuracy) {
  return {
    test_type: type,
    result_json: {
      raw_result: {
        accuracy,
        average_reaction_time_ms: 430
      },
      finished_at: '2026-08-21T08:20:00.000Z'
    }
  }
}

function reset(withData = true) {
  calls.requests = []
  calls.navigateTo = []
  calls.navigateBack = []
  calls.canvas = []
  storage = {
    access_token: 'test-token',
    current_user: {
      id: 1,
      role: 'patient',
      full_name: '报告测试患者',
      patient_profile: {
        patient_type: 'adult'
      }
    }
  }
  if (withData) {
    storage[SCALE_LATEST_RESULT_KEY] = scaleResult()
    storage[LATEST_RESULTS_KEY] = {
      reaction: cognitivePayload('reaction', 80),
      stroop: cognitivePayload('stroop', 75)
    }
    storage[TRACKING_LOGS_KEY] = [{
      day_index: 1,
      mood_tag: '4',
      attention_rating: 3,
      focus_minutes: 60
    }]
  }
  requestImplementation = async () => ({})
}

async function run() {
  reset()
  requestImplementation = async () => ({
    patient_name: '服务器患者',
    patient_type: 'adult',
    latest_scale: scaleResult(35),
    cognitive_profile: null,
    tracking_summary: null
  })
  const successPage = createPage()
  successPage.onLoad()
  assert.equal(successPage.data.patientName, '报告测试患者')
  assert.equal(successPage.data.sourceLabel, '本地结果')
  assert.equal(successPage.data.hasAnyData, true)
  await successPage.onShow()
  assert.deepEqual(calls.requests, [{
    url: '/patient/comprehensive_report',
    method: 'GET'
  }])
  assert.equal(successPage.data.loading, false)
  assert.equal(successPage.data.sourceLabel, '已同步')
  assert.equal(successPage.data.scale.totalScore, 35)
  assert.equal(
    calls.canvas.some((call) => call[0] === 'reportRadarCanvas'),
    true
  )
  assert.equal(
    calls.canvas.some((call) => call[0] === 'reportTrendCanvas'),
    true
  )

  reset()
  requestImplementation = async () => {
    throw new Error('offline')
  }
  const offlinePage = createPage()
  offlinePage.onLoad()
  await offlinePage.onShow()
  assert.equal(offlinePage.data.loading, false)
  assert.equal(offlinePage.data.sourceLabel, '本地结果')
  assert.equal(offlinePage.data.hasAnyData, true)
  assert.equal(
    offlinePage.data.statusMessage,
    '暂时无法同步，当前展示本地结果'
  )

  reset()
  let releaseRequest
  requestImplementation = () => new Promise((resolve) => {
    releaseRequest = () => resolve({
      latest_scale: scaleResult(32)
    })
  })
  const guardedPage = createPage()
  guardedPage.onLoad()
  const firstRefresh = guardedPage.onShow()
  const secondRefresh = guardedPage.onShow()
  assert.equal(calls.requests.length, 1)
  releaseRequest()
  await Promise.all([firstRefresh, secondRefresh])
  assert.equal(guardedPage.data.loading, false)

  reset(false)
  requestImplementation = async () => ({
    patient_name: '报告测试患者',
    patient_type: 'adult',
    latest_scale: null,
    cognitive_profile: null,
    tracking_summary: null
  })
  const emptyPage = createPage()
  emptyPage.onLoad()
  await emptyPage.onShow()
  assert.equal(emptyPage.data.hasAnyData, false)
  assert.equal(emptyPage.data.coverage.percent, 0)
  assert.equal(calls.canvas.length, 0)

  emptyPage.openTask({ currentTarget: { dataset: { task: 'scale' } } })
  emptyPage.openTask({ currentTarget: { dataset: { task: 'cognitive' } } })
  emptyPage.openTask({ currentTarget: { dataset: { task: 'tracking' } } })
  emptyPage.openTask({ currentTarget: { dataset: { task: 'unknown' } } })
  emptyPage.openTrend()
  assert.deepEqual(calls.navigateTo, [
    { url: '/pages/scale/index' },
    { url: '/pages/cognitive-center/index' },
    { url: '/pages/tracking/index' },
    { url: '/pages/tracking-trend/index' }
  ])

  emptyPage.goBack()
  assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

  console.log('综合报告页面控制逻辑测试全部通过')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
