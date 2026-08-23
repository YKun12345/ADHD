const assert = require('node:assert/strict')

const { clearPatientData } = require('../utils/session-privacy')
const { SCALE_LATEST_RESULT_KEY } = require('../utils/report-data')
const { ASRS_DRAFT_KEY } = require('../utils/asrs-scale')

const cognitiveModulePath = require.resolve('../pages/cognitive/index')
const scaleModulePath = require.resolve('../pages/scale/index')

const previousPage = global.Page
const previousWx = global.wx
const previousGetApp = global.getApp
const previousGetCurrentPages = global.getCurrentPages

let pageDefinition
let storage
let requestOptions
let currentPages
let writes

function configureBoundary(initialStorage) {
  storage = Object.assign({}, initialStorage)
  requestOptions = []
  currentPages = []
  writes = []

  global.Page = (definition) => {
    pageDefinition = definition
  }
  global.getApp = () => ({
    globalData: {
      isLoggedIn: true,
      userInfo: storage.current_user
    }
  })
  global.getCurrentPages = () => currentPages
  global.wx = {
    getStorageSync(key) {
      return storage[key]
    },
    setStorageSync(key, value) {
      writes.push([key, value])
      storage[key] = value
    },
    removeStorageSync(key) {
      delete storage[key]
    },
    request(options) {
      requestOptions.push(options)
    },
    reLaunch() {},
    showToast() {},
    navigateBack() {}
  }
}

function loadPage(modulePath) {
  pageDefinition = undefined
  delete require.cache[modulePath]
  require(modulePath)
  assert.ok(pageDefinition)

  const page = {
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(changes, callback) {
      Object.assign(this.data, changes)
      if (typeof callback === 'function') callback()
    }
  }

  Object.keys(pageDefinition).forEach((key) => {
    if (typeof pageDefinition[key] === 'function') {
      page[key] = pageDefinition[key]
    }
  })
  currentPages = [page]
  return page
}

function patientStorage() {
  return {
    api_base_url: 'https://api.example.com/api/v1',
    access_token: 'patient-token',
    current_user: {
      id: 7,
      role: 'patient',
      full_name: 'Integration Patient',
      patient_profile: { patient_type: 'adult' }
    }
  }
}

async function run() {
  try {
    configureBoundary(patientStorage())
    const cognitivePage = loadPage(cognitiveModulePath)
    const payload = {
      test_type: 'go_no_go',
      raw_data: { records: [] },
      metrics: { total_trials: 12 }
    }
    const cognitiveSync = cognitivePage._syncResult(payload)
    requestOptions[0].success({
      statusCode: 401,
      data: { detail: 'patient session expired' }
    })
    await cognitiveSync

    assert.equal(
      Object.prototype.hasOwnProperty.call(
        storage,
        'pending_cognitive_result'
      ),
      false,
      'a real 401 cleanup must not be followed by cognitive pending-data restore'
    )
    assert.equal(
      writes.some(([key]) => key === 'pending_cognitive_result'),
      false
    )

    configureBoundary(Object.assign(patientStorage(), {
      [ASRS_DRAFT_KEY]: Array(18).fill(2)
    }))
    const scalePage = loadPage(scaleModulePath)
    scalePage.onLoad()
    const scaleSubmission = scalePage.submitScale()

    clearPatientData()
    requestOptions[0].success({
      statusCode: 200,
      data: {
        total_score: 20,
        risk_level: 'low',
        summary: 'stale result',
        recommendations: ['stale recommendation'],
        created_at: '2026-08-24T00:00:00.000Z'
      }
    })
    await scaleSubmission

    assert.equal(
      Object.prototype.hasOwnProperty.call(storage, SCALE_LATEST_RESULT_KEY),
      false,
      'an old 200 must not rebuild scale result cache after local cleanup'
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(storage, ASRS_DRAFT_KEY),
      false
    )
    assert.equal(scalePage.data.showResult, false)
  } finally {
    delete require.cache[cognitiveModulePath]
    delete require.cache[scaleModulePath]
    if (previousPage === undefined) delete global.Page
    else global.Page = previousPage
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
    if (previousGetApp === undefined) delete global.getApp
    else global.getApp = previousGetApp
    if (previousGetCurrentPages === undefined) delete global.getCurrentPages
    else global.getCurrentPages = previousGetCurrentPages
  }

  console.log('Patient request integration tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
