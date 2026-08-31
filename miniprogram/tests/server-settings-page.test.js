const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  SESSION_KEYS,
  PATIENT_DATA_KEYS
} = require('../utils/session-privacy')

const pagePath = path.join(
  __dirname,
  '..',
  'pages',
  'server-settings',
  'index.js'
)

assert.equal(
  fs.existsSync(pagePath),
  true,
  '服务器设置页控制器尚未创建'
)

const calls = {
  requests: [],
  writes: [],
  removals: [],
  toasts: [],
  navigateBack: [],
  reLaunches: []
}
let storage = {}
let requestImplementation = async () => ({ status: 'ok' })
let pageDefinition
let failedRemovalKey = ''
let currentPages = []
let reLaunchImplementation
const app = {
  globalData: {
    isLoggedIn: false,
    userInfo: null
  }
}

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

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  setStorageSync(key, value) {
    storage[key] = value
    calls.writes.push([key, value])
  },
  removeStorageSync(key) {
    if (key === failedRemovalKey) {
      throw new Error(`cannot remove ${key}`)
    }
    delete storage[key]
    calls.removals.push(key)
  },
  showToast(options) {
    calls.toasts.push(options)
  },
  navigateBack(options) {
    calls.navigateBack.push(options)
  },
  reLaunch(options) {
    calls.reLaunches.push(options)
    return reLaunchImplementation(options)
  }
}

global.getApp = () => app
global.getCurrentPages = () => currentPages

global.Page = (definition) => {
  pageDefinition = definition
}

delete require.cache[require.resolve(pagePath)]
require(pagePath)

function createPage() {
  return {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(patch) {
      this.data = { ...this.data, ...patch }
    }
  }
}

function reset(overrides = {}) {
  calls.requests = []
  calls.writes = []
  calls.removals = []
  calls.toasts = []
  calls.navigateBack = []
  calls.reLaunches = []
  storage = { ...overrides }
  failedRemovalKey = ''
  currentPages = []
  reLaunchImplementation = (options) => {
    if (typeof options.success === 'function') options.success()
  }
  requestImplementation = async () => ({ status: 'ok' })
  app.globalData.isLoggedIn = Boolean(storage.access_token)
  app.globalData.userInfo = storage.current_user || null
}

async function run() {
  reset()
  const defaultPage = createPage()
  defaultPage.onLoad()
  assert.equal(defaultPage.data.address, 'http://127.0.0.1:8000/api/v1')
  assert.equal(defaultPage.data.environmentLabel, '本机开发')

  reset({
    api_base_url: 'http://192.168.1.8:8000/api/v1',
    access_token: 'server-a-token',
    current_user: { id: 7, role: 'patient' },
    scale_latest_result: { server: 'a', patientId: 7 }
  })
  const savedPage = createPage()
  savedPage.onLoad()
  assert.equal(savedPage.data.address, 'http://192.168.1.8:8000/api/v1')
  assert.equal(savedPage.data.environmentLabel, '局域网调试')

  savedPage.onAddressInput({ detail: { value: 'http://8.8.8.8:8000' } })
  await savedPage.testAndSave()
  assert.equal(calls.requests.length, 0)
  assert.equal(calls.writes.length, 0)
  assert.match(savedPage.data.statusMessage, /HTTP/)

  savedPage.onAddressInput({ detail: { value: 'https://api.example.com' } })
  await savedPage.testAndSave()
  assert.deepEqual(calls.requests, [{
    url: '/health',
    method: 'GET',
    baseUrl: 'https://api.example.com/api/v1',
    skipAuth: true
  }])
  assert.deepEqual(calls.writes, [[
    'api_base_url',
    'https://api.example.com/api/v1'
  ]])
  assert.deepEqual(calls.removals, [
    ...PATIENT_DATA_KEYS,
    ...SESSION_KEYS
  ])
  assert.equal(storage.scale_latest_result, undefined)
  assert.equal(storage.access_token, undefined)
  assert.equal(storage.current_user, undefined)
  assert.equal(app.globalData.isLoggedIn, false)
  assert.equal(app.globalData.userInfo, null)
  assert.equal(calls.reLaunches.length, 1)
  assert.equal(calls.reLaunches[0].url, '/pages/login/index')
  assert.equal(typeof calls.reLaunches[0].fail, 'function')
  assert.equal(savedPage.data.address, 'https://api.example.com/api/v1')
  assert.equal(savedPage.data.environmentLabel, 'HTTPS 正式环境')
  assert.equal(savedPage.data.statusType, 'success')

  reset()
  let finishRequest
  requestImplementation = () => new Promise((resolve) => {
    finishRequest = resolve
  })
  const duplicatePage = createPage()
  duplicatePage.onLoad()
  duplicatePage.onAddressInput({ detail: { value: 'http://192.168.0.9:8000' } })
  const firstRequest = duplicatePage.testAndSave()
  const secondRequest = duplicatePage.testAndSave()
  assert.equal(calls.requests.length, 1, '连接测试期间应阻止重复点击')
  finishRequest({ status: 'ok' })
  await Promise.all([firstRequest, secondRequest])

  reset({
    api_base_url: 'https://api-a.example.com/api/v1',
    access_token: 'server-a-token',
    current_user: { id: 7, role: 'patient' }
  })
  let finishCancelledRequest
  requestImplementation = () => new Promise((resolve) => {
    finishCancelledRequest = resolve
  })
  const cancelledPage = createPage()
  cancelledPage.onLoad()
  cancelledPage.onAddressInput({
    detail: { value: 'https://api-b.example.com' }
  })
  const cancelledRequest = cancelledPage.testAndSave()
  cancelledPage.goBack()
  finishCancelledRequest({ status: 'ok' })
  await cancelledRequest
  assert.equal(
    storage.api_base_url,
    'https://api-a.example.com/api/v1'
  )
  assert.deepEqual(calls.writes, [])
  assert.deepEqual(calls.removals, [])
  assert.deepEqual(calls.reLaunches, [])
  assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

  reset({
    api_base_url: 'https://api-a.example.com/api/v1',
    access_token: 'server-a-token',
    current_user: { id: 7, role: 'patient' }
  })
  let finishEditedRequest
  requestImplementation = () => new Promise((resolve) => {
    finishEditedRequest = resolve
  })
  const editedPage = createPage()
  editedPage.onLoad()
  editedPage.onAddressInput({
    detail: { value: 'https://api-b.example.com' }
  })
  const editedRequest = editedPage.testAndSave()
  editedPage.onAddressInput({
    detail: { value: 'https://api-c.example.com' }
  })
  finishEditedRequest({ status: 'ok' })
  await editedRequest
  assert.equal(editedPage.data.address, 'https://api-c.example.com')
  assert.equal(editedPage.data.testing, false)
  assert.deepEqual(calls.writes, [])
  assert.deepEqual(calls.removals, [])
  assert.deepEqual(calls.reLaunches, [])

  reset()
  requestImplementation = async () => ({ status: 'unexpected' })
  const invalidHealthPage = createPage()
  invalidHealthPage.onLoad()
  invalidHealthPage.onAddressInput({ detail: { value: 'http://10.0.0.5:8000' } })
  await invalidHealthPage.testAndSave()
  assert.equal(calls.writes.length, 0)
  assert.equal(invalidHealthPage.data.statusType, 'error')
  assert.match(invalidHealthPage.data.statusMessage, /健康检查/)

  reset({
    api_base_url: 'https://api-a.example.com/api/v1',
    access_token: 'server-a-token',
    current_user: { id: 7, role: 'patient' }
  })
  failedRemovalKey = 'current_user'
  const failedCleanupPage = createPage()
  failedCleanupPage.onLoad()
  failedCleanupPage.onAddressInput({
    detail: { value: 'https://api-b.example.com' }
  })
  await failedCleanupPage.testAndSave()
  assert.equal(
    storage.api_base_url,
    'https://api-a.example.com/api/v1'
  )
  assert.deepEqual(calls.writes, [])
  assert.equal(calls.reLaunches.length, 1)
  assert.equal(calls.reLaunches[0].url, '/pages/login/index')
  assert.equal(failedCleanupPage.data.statusType, 'error')
  assert.match(failedCleanupPage.data.statusMessage, /清理失败/)

  reset({
    api_base_url: 'https://api-a.example.com/api/v1',
    access_token: 'server-a-token',
    current_user: { id: 7, role: 'patient' },
    scale_latest_result: { owner: 'Alice' }
  })
  currentPages = [{
    data: { patientName: 'Alice', secret: 'private' },
    setData() {
      throw new Error('page scrub failed')
    }
  }]
  const failedPageCleanup = createPage()
  failedPageCleanup.onLoad()
  failedPageCleanup.onAddressInput({
    detail: { value: 'https://api-b.example.com' }
  })
  await failedPageCleanup.testAndSave()
  assert.equal(
    storage.api_base_url,
    'https://api-a.example.com/api/v1'
  )
  assert.deepEqual(calls.writes, [])
  assert.equal(calls.reLaunches.length, 1)
  assert.equal(calls.reLaunches[0].url, '/pages/login/index')
  assert.equal(failedPageCleanup.data.statusType, 'error')
  assert.match(failedPageCleanup.data.statusMessage, /清理失败/)

  reset({
    api_base_url: 'https://api-a.example.com/api/v1',
    access_token: 'server-a-token',
    current_user: { id: 7, role: 'patient' }
  })
  reLaunchImplementation = (options) => {
    if (typeof options.fail === 'function') {
      options.fail(new Error('reLaunch failed'))
    }
  }
  const failedReturnPage = createPage()
  failedReturnPage.onLoad()
  failedReturnPage.onAddressInput({
    detail: { value: 'https://api-b.example.com' }
  })
  await failedReturnPage.testAndSave()
  assert.equal(
    storage.api_base_url,
    'https://api-b.example.com/api/v1'
  )
  assert.match(calls.toasts.at(-1).title, /返回登录页失败/)

  reset({ api_base_url: 'https://api.example.com/api/v1' })
  const resetPage = createPage()
  resetPage.onLoad()
  resetPage.restoreDefault()
  assert.deepEqual(calls.removals, [
    ...PATIENT_DATA_KEYS,
    ...SESSION_KEYS,
    'api_base_url'
  ])
  assert.equal(calls.reLaunches.length, 1)
  assert.equal(calls.reLaunches[0].url, '/pages/login/index')
  assert.equal(typeof calls.reLaunches[0].fail, 'function')
  assert.equal(resetPage.data.address, 'http://127.0.0.1:8000/api/v1')
  assert.equal(resetPage.data.environmentLabel, '本机开发')

  reset({
    api_base_url: 'https://api-b.example.com/api/v1',
    access_token: 'server-b-token',
    current_user: { id: 8, role: 'patient' }
  })
  const frozenPatientData = Object.freeze({
    patientName: 'PATIENT-A',
    report: Object.freeze({ secret: 'private' })
  })
  currentPages = [{
    data: frozenPatientData,
    setData() {
      throw new Error('page scrub failed')
    }
  }]
  const failedRestoreCleanupPage = createPage()
  failedRestoreCleanupPage.onLoad()
  failedRestoreCleanupPage.restoreDefault()
  assert.equal(
    storage.api_base_url,
    'https://api-b.example.com/api/v1'
  )
  assert.equal(storage.access_token, undefined)
  assert.equal(storage.current_user, undefined)
  assert.equal(frozenPatientData.patientName, 'PATIENT-A')
  assert.equal(calls.reLaunches.length, 1)
  assert.equal(calls.reLaunches[0].url, '/pages/login/index')
  assert.equal(typeof calls.reLaunches[0].fail, 'function')

  resetPage.goBack()
  assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

  console.log('服务器设置页面控制逻辑测试全部通过')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
