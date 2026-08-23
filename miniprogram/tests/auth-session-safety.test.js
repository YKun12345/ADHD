const assert = require('node:assert/strict')

const {
  PATIENT_DATA_KEYS,
  getPatientDataRevision
} = require('../utils/session-privacy')

const requestModulePath = require.resolve('../utils/request')
const loginModulePath = require.resolve('../pages/login/index')
const registerModulePath = require.resolve('../pages/register/index')

const previousPage = global.Page
const previousWx = global.wx
const previousGetApp = global.getApp
const previousGetCurrentPages = global.getCurrentPages
const previousSetTimeout = global.setTimeout

let requestImplementation
let pageDefinition
let storage
let failedRemovalKey
let failedWriteKey
let timerCallbacks

const app = {
  globalData: {
    isLoggedIn: false,
    userInfo: null
  }
}

const calls = {
  removals: [],
  requests: [],
  reLaunches: [],
  toasts: [],
  writes: []
}

function reset(initialStorage) {
  storage = Object.assign({}, initialStorage)
  failedRemovalKey = ''
  failedWriteKey = ''
  timerCallbacks = []
  app.globalData.isLoggedIn = true
  app.globalData.userInfo = storage.current_user || null

  Object.keys(calls).forEach((key) => {
    calls[key].length = 0
  })
}

function loadPage(modulePath) {
  pageDefinition = undefined
  delete require.cache[modulePath]
  require(modulePath)
  assert.ok(pageDefinition)
  return pageDefinition
}

function createPage(definition) {
  const page = {
    data: Object.assign({}, definition.data),
    setData(changes) {
      Object.assign(this.data, changes)
    }
  }

  Object.keys(definition).forEach((key) => {
    if (typeof definition[key] === 'function') {
      page[key] = definition[key]
    }
  })

  return page
}

function authResponse(id) {
  return {
    access_token: `token-${id}`,
    token_type: 'bearer',
    user: {
      id,
      email: `patient-${id}@example.com`,
      full_name: `Patient ${id}`,
      role: 'patient',
      patient_profile: null
    }
  }
}

function patientStorage(id) {
  return {
    api_base_url: 'https://api.example.com/api/v1',
    access_token: `old-token-${id}`,
    current_user: authResponse(id).user,
    ...Object.fromEntries(PATIENT_DATA_KEYS.map((key) => [key, { owner: id }]))
  }
}

function configureGlobals() {
  require.cache[requestModulePath] = {
    id: requestModulePath,
    filename: requestModulePath,
    loaded: true,
    exports: {
      request(options) {
        calls.requests.push(options)
        return requestImplementation(options)
      }
    }
  }

  global.Page = (definition) => {
    pageDefinition = definition
  }
  global.getApp = () => app
  global.getCurrentPages = () => [{}]
  global.setTimeout = (callback) => {
    timerCallbacks.push(callback)
    return timerCallbacks.length
  }
  global.wx = {
    getStorageSync(key) {
      return storage[key]
    },
    removeStorageSync(key) {
      calls.removals.push(key)
      if (key === failedRemovalKey) {
        throw new Error(`cannot remove ${key}`)
      }
      delete storage[key]
    },
    setStorageSync(key, value) {
      if (key === failedWriteKey) {
        throw new Error(`cannot write ${key}`)
      }
      calls.writes.push([key, value])
      storage[key] = value
    },
    showToast(options) {
      calls.toasts.push(options)
    },
    reLaunch(options) {
      calls.reLaunches.push(options)
      if (typeof options.success === 'function') options.success()
    },
    navigateTo() {},
    navigateBack() {},
    showModal() {}
  }
}

async function runLoginScenarios() {
  const definition = loadPage(loginModulePath)

  reset(patientStorage(1))
  requestImplementation = async () => authResponse(2)
  const loginPage = createPage(definition)
  loginPage.setData({
    identifier: 'patient-2@example.com',
    password: 'BrainMap#2026'
  })

  await loginPage.handleLogin()

  assert.equal(calls.requests.length, 1)
  assert.equal(calls.requests[0].skipAuth, true)
  assert.deepEqual(calls.removals, PATIENT_DATA_KEYS)
  assert.deepEqual(calls.writes.map(([key]) => key), [
    'current_user',
    'access_token'
  ])
  assert.equal(storage.api_base_url, 'https://api.example.com/api/v1')
  assert.equal(app.globalData.isLoggedIn, true)
  assert.equal(app.globalData.userInfo.id, 2)

  reset(patientStorage(1))
  failedRemovalKey = 'scale_latest_result'
  requestImplementation = async () => authResponse(2)
  const failedClearPage = createPage(definition)
  failedClearPage.setData({
    identifier: 'patient-2@example.com',
    password: 'BrainMap#2026'
  })

  await failedClearPage.handleLogin()

  assert.deepEqual(calls.writes, [])
  assert.equal(storage.access_token, 'old-token-1')
  assert.equal(storage.current_user.id, 1)
  assert.equal(failedClearPage.data.submitting, false)
  assert.match(calls.toasts[calls.toasts.length - 1].title, /清理失败/)

  reset(patientStorage(2))
  requestImplementation = async () => authResponse(2)
  const samePatientPage = createPage(definition)
  samePatientPage.setData({
    identifier: 'patient-2@example.com',
    password: 'BrainMap#2026'
  })

  const revisionBeforeSamePatientLogin = getPatientDataRevision()
  await samePatientPage.handleLogin()

  assert.deepEqual(calls.removals, [])
  assert.deepEqual(storage.patient_dashboard_cache, { owner: 2 })
  assert.deepEqual(calls.writes.map(([key]) => key), [
    'current_user',
    'access_token'
  ])
  assert.equal(
    getPatientDataRevision(),
    revisionBeforeSamePatientLogin + 1
  )

  for (const writeKey of ['current_user', 'access_token']) {
    reset(patientStorage(2))
    failedWriteKey = writeKey
    requestImplementation = async () => authResponse(2)
    const failedWritePage = createPage(definition)
    failedWritePage.setData({
      identifier: 'patient-2@example.com',
      password: 'BrainMap#2026'
    })

    await failedWritePage.handleLogin()

    assert.equal(
      Object.prototype.hasOwnProperty.call(storage, 'access_token'),
      false
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(storage, 'current_user'),
      false
    )
    assert.equal(app.globalData.isLoggedIn, false)
    assert.equal(app.globalData.userInfo, null)
    assert.equal(timerCallbacks.length, 0)
    assert.match(calls.toasts[calls.toasts.length - 1].title, /保存失败/)
  }

  reset(patientStorage(2))
  failedWriteKey = 'access_token'
  failedRemovalKey = 'access_token'
  requestImplementation = async () => authResponse(2)
  const failedRollbackPage = createPage(definition)
  failedRollbackPage.setData({
    identifier: 'patient-2@example.com',
    password: 'BrainMap#2026'
  })

  await failedRollbackPage.handleLogin()

  assert.equal(app.globalData.isLoggedIn, false)
  assert.equal(app.globalData.userInfo, null)
  assert.equal(
    Object.prototype.hasOwnProperty.call(storage, 'current_user'),
    false
  )
  assert.equal(storage.access_token, 'old-token-2')
  assert.match(calls.toasts[calls.toasts.length - 1].title, /回滚失败/)
  assert.equal(timerCallbacks.length, 0)

  reset({
    access_token: 'bad-token',
    current_user: { full_name: 'Missing id and role' }
  })
  definition.onShow()
  assert.deepEqual(calls.reLaunches, [])

  reset({
    access_token: 'valid-token',
    current_user: authResponse(3).user
  })
  definition.onShow()
  assert.equal(calls.reLaunches.length, 1)
  assert.equal(calls.reLaunches[0].url, '/pages/home/index')
}

async function runRegisterScenarios() {
  const definition = loadPage(registerModulePath)
  const validForm = {
    fullName: 'Patient Three',
    email: 'patient-3@example.com',
    patientType: 'adult',
    age: '20',
    gender: 'female',
    password: 'BrainMap#2026',
    confirmPassword: 'BrainMap#2026',
    consentAgreed: true
  }

  reset(patientStorage(1))
  requestImplementation = async () => authResponse(3)
  const registerPage = createPage(definition)
  registerPage.setData(validForm)

  await registerPage.handleSubmit()

  assert.equal(calls.requests.length, 1)
  assert.equal(calls.requests[0].skipAuth, true)
  assert.deepEqual(calls.removals, PATIENT_DATA_KEYS)
  assert.deepEqual(calls.writes.map(([key]) => key), [
    'current_user',
    'access_token'
  ])
  assert.equal(app.globalData.userInfo.id, 3)

  reset(patientStorage(1))
  failedRemovalKey = 'pending_stroop_result'
  requestImplementation = async () => authResponse(3)
  const failedClearPage = createPage(definition)
  failedClearPage.setData(validForm)

  await failedClearPage.handleSubmit()

  assert.deepEqual(calls.writes, [])
  assert.equal(storage.access_token, 'old-token-1')
  assert.equal(storage.current_user.id, 1)
  assert.equal(failedClearPage.data.submitting, false)
  assert.match(calls.toasts[calls.toasts.length - 1].title, /清理失败/)

  reset(patientStorage(3))
  failedWriteKey = 'access_token'
  failedRemovalKey = 'access_token'
  requestImplementation = async () => authResponse(3)
  const failedRegisterRollbackPage = createPage(definition)
  failedRegisterRollbackPage.setData(validForm)

  await failedRegisterRollbackPage.handleSubmit()

  assert.equal(app.globalData.isLoggedIn, false)
  assert.equal(app.globalData.userInfo, null)
  assert.equal(
    Object.prototype.hasOwnProperty.call(storage, 'current_user'),
    false
  )
  assert.equal(storage.access_token, 'old-token-3')
  assert.equal(failedRegisterRollbackPage.data.submitting, false)
  assert.match(calls.toasts[calls.toasts.length - 1].title, /回滚失败/)
  assert.equal(calls.reLaunches.length, 0)
}

async function run() {
  configureGlobals()

  try {
    await runLoginScenarios()
    await runRegisterScenarios()
  } finally {
    delete require.cache[loginModulePath]
    delete require.cache[registerModulePath]
    delete require.cache[requestModulePath]

    if (previousPage === undefined) delete global.Page
    else global.Page = previousPage
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
    if (previousGetApp === undefined) delete global.getApp
    else global.getApp = previousGetApp
    if (previousGetCurrentPages === undefined) delete global.getCurrentPages
    else global.getCurrentPages = previousGetCurrentPages
    global.setTimeout = previousSetTimeout
  }

  console.log('Auth session safety tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
