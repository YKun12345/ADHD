const assert = require('node:assert/strict')

const {
  SESSION_KEYS,
  PATIENT_DATA_KEYS,
  hasValidPatientSession,
  getPatientDataRevision,
  advancePatientDataRevision
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
let failedRemovalKeys
let failedWriteKey
let timerCallbacks
let getAppCallCount
let throwOnGetAppCall
let reLaunchImplementation

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
  failedRemovalKeys = new Set()
  failedWriteKey = ''
  timerCallbacks = []
  getAppCallCount = 0
  throwOnGetAppCall = 0
  reLaunchImplementation = (options) => {
    if (typeof options.success === 'function') options.success()
  }
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
  global.getApp = () => {
    getAppCallCount += 1
    if (getAppCallCount === throwOnGetAppCall) {
      throw new Error('app state unavailable')
    }
    return app
  }
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
      if (key === failedRemovalKey || failedRemovalKeys.has(key)) {
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
      return reLaunchImplementation(options)
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
  assert.deepEqual(calls.removals, [
    ...PATIENT_DATA_KEYS,
    ...SESSION_KEYS
  ])
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

  assert.deepEqual(calls.removals, SESSION_KEYS)
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
  assert.match(calls.toasts[calls.toasts.length - 1].title, /清理失败/)
  assert.equal(timerCallbacks.length, 0)

  reset(patientStorage(1))
  failedWriteKey = 'access_token'
  failedRemovalKeys = new Set(SESSION_KEYS)
  requestImplementation = async () => authResponse(2)
  const correlatedStorageFailurePage = createPage(definition)
  correlatedStorageFailurePage.setData({
    identifier: 'patient-2@example.com',
    password: 'BrainMap#2026'
  })

  await correlatedStorageFailurePage.handleLogin()

  assert.deepEqual(calls.writes, [])
  assert.equal(storage.access_token, 'old-token-1')
  assert.equal(storage.current_user.id, 1)
  assert.equal(hasValidPatientSession((key) => storage[key]), true)
  assert.match(calls.toasts[calls.toasts.length - 1].title, /清理失败/)

  reset(patientStorage(1))
  throwOnGetAppCall = 2
  requestImplementation = async () => authResponse(2)
  const failedAppCommitPage = createPage(definition)
  failedAppCommitPage.setData({
    identifier: 'patient-2@example.com',
    password: 'BrainMap#2026'
  })

  await failedAppCommitPage.handleLogin()

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
  assert.match(calls.toasts.at(-1).title, /保存|回滚/)

  reset(patientStorage(1))
  let releaseStaleLogin
  requestImplementation = () => new Promise((resolve) => {
    releaseStaleLogin = resolve
  })
  const staleLoginPage = createPage(definition)
  staleLoginPage.setData({
    identifier: 'patient-1@example.com',
    password: 'BrainMap#2026'
  })
  const staleLogin = staleLoginPage.handleLogin()
  storage = patientStorage(2)
  advancePatientDataRevision()
  releaseStaleLogin(authResponse(1))
  await staleLogin

  assert.equal(storage.access_token, 'old-token-2')
  assert.equal(storage.current_user.id, 2)
  assert.deepEqual(storage.scale_latest_result, { owner: 2 })
  assert.deepEqual(calls.writes, [])

  reset(patientStorage(1))
  let releaseHiddenLogin
  requestImplementation = () => new Promise((resolve) => {
    releaseHiddenLogin = resolve
  })
  const hiddenLoginPage = createPage(definition)
  hiddenLoginPage.setData({
    identifier: 'patient-1@example.com',
    password: 'BrainMap#2026'
  })
  const hiddenLogin = hiddenLoginPage.handleLogin()
  assert.equal(typeof hiddenLoginPage.onHide, 'function')
  hiddenLoginPage.onHide()
  releaseHiddenLogin(authResponse(1))
  await hiddenLogin

  assert.equal(storage.access_token, 'old-token-1')
  assert.equal(storage.current_user.id, 1)
  assert.deepEqual(calls.writes, [])

  for (const navigationMethod of ['goToRegister', 'openServerSettings']) {
    reset(patientStorage(1))
    let releaseNavigatedLogin
    requestImplementation = () => new Promise((resolve) => {
      releaseNavigatedLogin = resolve
    })
    const navigatedLoginPage = createPage(definition)
    navigatedLoginPage.setData({
      identifier: 'patient-2@example.com',
      password: 'BrainMap#2026'
    })
    const navigatedLogin = navigatedLoginPage.handleLogin()
    navigatedLoginPage[navigationMethod]()
    releaseNavigatedLogin(authResponse(2))
    await navigatedLogin

    assert.equal(storage.access_token, 'old-token-1')
    assert.equal(storage.current_user.id, 1)
    assert.deepEqual(calls.writes, [])
  }

  reset(patientStorage(1))
  let releaseOriginChangedLogin
  requestImplementation = () => new Promise((resolve) => {
    releaseOriginChangedLogin = resolve
  })
  const originChangedLoginPage = createPage(definition)
  originChangedLoginPage.setData({
    identifier: 'patient-1@example.com',
    password: 'BrainMap#2026'
  })
  const originChangedLogin = originChangedLoginPage.handleLogin()
  storage.api_base_url = 'https://api-b.example.com/api/v1'
  releaseOriginChangedLogin(authResponse(1))
  await originChangedLogin

  assert.equal(storage.access_token, 'old-token-1')
  assert.equal(storage.current_user.id, 1)
  assert.deepEqual(calls.writes, [])

  reset(patientStorage(1))
  let rejectHiddenLogin
  requestImplementation = () => new Promise((resolve, reject) => {
    rejectHiddenLogin = reject
  })
  const hiddenFailedLoginPage = createPage(definition)
  hiddenFailedLoginPage.setData({
    identifier: 'patient-1@example.com',
    password: 'BrainMap#2026'
  })
  const hiddenFailedLogin = hiddenFailedLoginPage.handleLogin()
  hiddenFailedLoginPage.onHide()
  rejectHiddenLogin(new Error('stale login failure'))
  await hiddenFailedLogin

  assert.deepEqual(calls.toasts, [])

  reset(patientStorage(1))
  requestImplementation = async () => authResponse(2)
  const completedLoginPage = createPage(definition)
  completedLoginPage.setData({
    identifier: 'patient-2@example.com',
    password: 'BrainMap#2026'
  })
  await completedLoginPage.handleLogin()
  assert.equal(timerCallbacks.length, 1)
  completedLoginPage.onHide()
  timerCallbacks[0]()
  assert.deepEqual(calls.reLaunches, [])

  reset(patientStorage(1))
  requestImplementation = async () => authResponse(2)
  const failedHomeNavigationPage = createPage(definition)
  failedHomeNavigationPage.setData({
    identifier: 'patient-2@example.com',
    password: 'BrainMap#2026'
  })
  await failedHomeNavigationPage.handleLogin()
  reLaunchImplementation = () => {
    throw new Error('reLaunch crashed')
  }
  assert.doesNotThrow(() => timerCallbacks[0]())
  assert.equal(storage.access_token, 'token-2')
  assert.equal(storage.current_user.id, 2)
  assert.equal(app.globalData.isLoggedIn, true)
  assert.match(calls.toasts.at(-1).title, /进入患者首页失败/)

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
  reLaunchImplementation = () => {
    throw new Error('onShow reLaunch crashed')
  }
  assert.doesNotThrow(() => definition.onShow())
  assert.equal(calls.reLaunches.length, 1)
  assert.equal(calls.reLaunches[0].url, '/pages/home/index')
  assert.match(calls.toasts.at(-1).title, /进入患者首页失败/)
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
  assert.deepEqual(calls.removals, [
    ...PATIENT_DATA_KEYS,
    ...SESSION_KEYS
  ])
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
  assert.match(calls.toasts[calls.toasts.length - 1].title, /清理失败/)
  assert.equal(calls.reLaunches.length, 0)

  reset(patientStorage(1))
  throwOnGetAppCall = 2
  requestImplementation = async () => authResponse(3)
  const failedAppCommitPage = createPage(definition)
  failedAppCommitPage.setData(validForm)

  await failedAppCommitPage.handleSubmit()

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
  assert.equal(calls.reLaunches.length, 0)
  assert.match(calls.toasts.at(-1).title, /保存|回滚/)

  reset(patientStorage(1))
  requestImplementation = async () => authResponse(3)
  reLaunchImplementation = () => {
    throw new Error('register reLaunch crashed')
  }
  const failedHomeNavigationPage = createPage(definition)
  failedHomeNavigationPage.setData(validForm)

  await failedHomeNavigationPage.handleSubmit()

  assert.equal(storage.access_token, 'token-3')
  assert.equal(storage.current_user.id, 3)
  assert.equal(app.globalData.isLoggedIn, true)
  assert.equal(calls.reLaunches.length, 1)
  assert.match(calls.toasts.at(-1).title, /进入患者首页失败/)
  assert.equal(
    calls.toasts.some((toast) => /注册失败/.test(toast.title)),
    false
  )

  reset(patientStorage(2))
  let releaseStaleRegister
  requestImplementation = () => new Promise((resolve) => {
    releaseStaleRegister = resolve
  })
  const staleRegisterPage = createPage(definition)
  staleRegisterPage.setData(validForm)
  const staleRegister = staleRegisterPage.handleSubmit()
  storage = patientStorage(3)
  advancePatientDataRevision()
  releaseStaleRegister(authResponse(2))
  await staleRegister

  assert.equal(storage.access_token, 'old-token-3')
  assert.equal(storage.current_user.id, 3)
  assert.deepEqual(storage.scale_latest_result, { owner: 3 })
  assert.deepEqual(calls.writes, [])

  reset(patientStorage(1))
  let releaseNavigatedRegister
  requestImplementation = () => new Promise((resolve) => {
    releaseNavigatedRegister = resolve
  })
  const navigatedRegisterPage = createPage(definition)
  navigatedRegisterPage.setData(validForm)
  const navigatedRegister = navigatedRegisterPage.handleSubmit()
  navigatedRegisterPage.goBackToLogin()
  releaseNavigatedRegister(authResponse(3))
  await navigatedRegister

  assert.equal(storage.access_token, 'old-token-1')
  assert.equal(storage.current_user.id, 1)
  assert.deepEqual(calls.writes, [])
  assert.equal(calls.reLaunches.length, 1)
  assert.equal(calls.reLaunches[0].url, '/pages/login/index')

  reset(patientStorage(1))
  let rejectHiddenRegister
  requestImplementation = () => new Promise((resolve, reject) => {
    rejectHiddenRegister = reject
  })
  const hiddenFailedRegisterPage = createPage(definition)
  hiddenFailedRegisterPage.setData(validForm)
  const hiddenFailedRegister = hiddenFailedRegisterPage.handleSubmit()
  hiddenFailedRegisterPage.onHide()
  rejectHiddenRegister(new Error('stale register failure'))
  await hiddenFailedRegister

  assert.deepEqual(calls.toasts, [])
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
