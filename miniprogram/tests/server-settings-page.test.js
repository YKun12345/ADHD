const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

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
  navigateBack: []
}
let storage = {}
let requestImplementation = async () => ({ status: 'ok' })
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

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  setStorageSync(key, value) {
    storage[key] = value
    calls.writes.push([key, value])
  },
  removeStorageSync(key) {
    delete storage[key]
    calls.removals.push(key)
  },
  showToast(options) {
    calls.toasts.push(options)
  },
  navigateBack(options) {
    calls.navigateBack.push(options)
  }
}

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
  storage = { ...overrides }
  requestImplementation = async () => ({ status: 'ok' })
}

async function run() {
  reset()
  const defaultPage = createPage()
  defaultPage.onLoad()
  assert.equal(defaultPage.data.address, 'http://127.0.0.1:8000/api/v1')
  assert.equal(defaultPage.data.environmentLabel, '本机开发')

  reset({ api_base_url: 'http://192.168.1.8:8000/api/v1' })
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

  reset()
  requestImplementation = async () => ({ status: 'unexpected' })
  const invalidHealthPage = createPage()
  invalidHealthPage.onLoad()
  invalidHealthPage.onAddressInput({ detail: { value: 'http://10.0.0.5:8000' } })
  await invalidHealthPage.testAndSave()
  assert.equal(calls.writes.length, 0)
  assert.equal(invalidHealthPage.data.statusType, 'error')
  assert.match(invalidHealthPage.data.statusMessage, /健康检查/)

  reset({ api_base_url: 'https://api.example.com/api/v1' })
  const resetPage = createPage()
  resetPage.onLoad()
  resetPage.restoreDefault()
  assert.deepEqual(calls.removals, ['api_base_url'])
  assert.equal(resetPage.data.address, 'http://127.0.0.1:8000/api/v1')
  assert.equal(resetPage.data.environmentLabel, '本机开发')

  resetPage.goBack()
  assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

  console.log('服务器设置页面控制逻辑测试全部通过')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
