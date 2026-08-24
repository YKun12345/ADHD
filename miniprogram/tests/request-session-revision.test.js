const assert = require('node:assert/strict')

const { request } = require('../utils/request')
const {
  advancePatientDataRevision,
  clearPatientData
} = require('../utils/session-privacy')

const previousWx = global.wx
const previousGetApp = global.getApp

let storage
let requests

function configureBoundary(initialStorage) {
  storage = Object.assign({}, initialStorage)
  requests = []

  global.getApp = () => ({
    globalData: {
      isLoggedIn: true,
      userInfo: storage.current_user
    }
  })
  global.wx = {
    getStorageSync(key) {
      return storage[key]
    },
    removeStorageSync(key) {
      delete storage[key]
    },
    reLaunch() {},
    request(options) {
      requests.push(options)
    }
  }
}

function authenticatedStorage(token = 'patient-token') {
  return {
    api_base_url: 'https://api.example.com/api/v1',
    access_token: token,
    current_user: {
      id: 7,
      role: 'patient'
    },
    patient_dashboard_cache: { owner: 7 }
  }
}

async function rejectedValue(promise) {
  let value
  await assert.rejects(promise, (error) => {
    value = error
    return true
  })
  return value
}

async function run() {
  try {
    configureBoundary(authenticatedStorage())
    const oldSuccess = request({ url: '/patient/dashboard_status' })
    clearPatientData()
    requests[0].success({
      statusCode: 200,
      data: { current_day: 9 }
    })
    const oldSuccessError = await rejectedValue(oldSuccess)
    assert.equal(oldSuccessError.code, 'SESSION_CHANGED')
    assert.equal(oldSuccessError.sessionChanged, true)

    configureBoundary(authenticatedStorage())
    const oldHttpError = request({ url: '/patient/comprehensive_report' })
    advancePatientDataRevision()
    requests[0].success({
      statusCode: 503,
      data: { detail: 'temporary server failure' }
    })
    const staleHttpError = await rejectedValue(oldHttpError)
    assert.equal(staleHttpError.message, 'temporary server failure')
    assert.equal(staleHttpError.statusCode, 503)
    assert.equal(staleHttpError.code, 'SESSION_CHANGED')
    assert.equal(staleHttpError.sessionChanged, true)

    configureBoundary(authenticatedStorage())
    const oldTransportFailure = request({ url: '/patient/dashboard_status' })
    advancePatientDataRevision()
    requests[0].fail({ errMsg: 'request:fail network error' })
    const staleTransportError = await rejectedValue(oldTransportFailure)
    assert.equal(staleTransportError.code, 'SESSION_CHANGED')
    assert.equal(staleTransportError.originalCode, 'NETWORK_ERROR')
    assert.equal(staleTransportError.sessionChanged, true)

    configureBoundary(authenticatedStorage('old-token'))
    const replacedTokenRequest = request({ url: '/patient/dashboard_status' })
    storage.access_token = 'new-token'
    requests[0].success({
      statusCode: 200,
      data: { current_day: 3 }
    })
    const replacedTokenError = await rejectedValue(replacedTokenRequest)
    assert.equal(replacedTokenError.code, 'SESSION_CHANGED')

    configureBoundary(authenticatedStorage())
    const replacedOriginRequest = request({
      url: '/patient/dashboard_status'
    })
    storage.api_base_url = 'https://api-b.example.com/api/v1'
    requests[0].success({
      statusCode: 200,
      data: { current_day: 11 }
    })
    const replacedOriginError = await rejectedValue(replacedOriginRequest)
    assert.equal(replacedOriginError.code, 'SESSION_CHANGED')
    assert.equal(replacedOriginError.sessionChanged, true)

    configureBoundary(authenticatedStorage())
    const currentRequest = request({ url: '/patient/dashboard_status' })
    requests[0].success({
      statusCode: 200,
      data: { current_day: 4 }
    })
    assert.deepEqual(await currentRequest, { current_day: 4 })

    configureBoundary(authenticatedStorage())
    const publicRequest = request({
      url: '/auth/login',
      method: 'POST',
      skipAuth: true
    })
    advancePatientDataRevision()
    requests[0].success({
      statusCode: 200,
      data: { access_token: 'new-auth-token' }
    })
    assert.deepEqual(await publicRequest, {
      access_token: 'new-auth-token'
    })
  } finally {
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
    if (previousGetApp === undefined) delete global.getApp
    else global.getApp = previousGetApp
  }

  console.log('Request session revision tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
