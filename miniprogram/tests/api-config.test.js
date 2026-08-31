const assert = require('node:assert/strict')

const {
  API_BASE_URL_KEY,
  DEFAULT_API_BASE_URL,
  normalizeApiBaseUrl,
  resolveApiBaseUrl
} = require('../utils/api-config')

assert.equal(API_BASE_URL_KEY, 'api_base_url')
assert.equal(DEFAULT_API_BASE_URL, 'http://127.0.0.1:8000/api/v1')

assert.deepEqual(normalizeApiBaseUrl(' http://127.0.0.1:8000/ '), {
  value: 'http://127.0.0.1:8000/api/v1', error: '', environment: 'local'
})
assert.deepEqual(normalizeApiBaseUrl('http://localhost:8000/api/v1/'), {
  value: 'http://localhost:8000/api/v1', error: '', environment: 'local'
})
assert.deepEqual(normalizeApiBaseUrl('http://192.168.1.8:8000'), {
  value: 'http://192.168.1.8:8000/api/v1', error: '', environment: 'lan'
})
assert.equal(normalizeApiBaseUrl('http://10.0.0.5:9000').environment, 'lan')
assert.equal(normalizeApiBaseUrl('http://172.16.0.2:8000').environment, 'lan')
assert.equal(normalizeApiBaseUrl('http://172.31.255.2:8000').environment, 'lan')
assert.deepEqual(normalizeApiBaseUrl('https://api.example.com/api/v1'), {
  value: 'https://api.example.com/api/v1', error: '', environment: 'secure'
})

for (const input of [
  '', 'ftp://192.168.1.2', 'http://8.8.8.8:8000',
  'http://172.32.0.1:8000', 'http://user:pass@192.168.1.2:8000',
  'https://api.example.com/other', 'https://api.example.com/api/v1?x=1',
  'https://api.example.com/api/v1#x', 'https://api example.com',
  'http://192.168.1.2:99999'
]) {
  assert.notEqual(normalizeApiBaseUrl(input).error, '', `应拒绝：${input}`)
}
assert.equal(resolveApiBaseUrl('http://192.168.0.9:8000'), 'http://192.168.0.9:8000/api/v1')
assert.equal(resolveApiBaseUrl('invalid'), DEFAULT_API_BASE_URL)
assert.equal(resolveApiBaseUrl(''), DEFAULT_API_BASE_URL)

let storedBaseUrl = ''
let token = 'test-token'
const requests = []
global.wx = {
  getStorageSync(key) {
    if (key === API_BASE_URL_KEY) return storedBaseUrl
    if (key === 'access_token') return token
    return undefined
  },
  request(options) {
    requests.push(options)
    options.success({ statusCode: 200, data: { status: 'ok' } })
  },
  removeStorageSync() {},
  reLaunch() {}
}

const { request, BASE_URL } = require('../utils/request')
assert.equal(BASE_URL, DEFAULT_API_BASE_URL)

async function run() {
  await request({ url: '/health', method: 'GET' })
  assert.equal(requests[0].url, 'http://127.0.0.1:8000/api/v1/health')
  assert.equal(requests[0].header.Authorization, 'Bearer test-token')

  storedBaseUrl = 'http://192.168.1.8:8000'
  await request({ url: '/patient/dashboard_status' })
  assert.equal(requests[1].url, 'http://192.168.1.8:8000/api/v1/patient/dashboard_status')

  await request({
    url: '/health',
    baseUrl: 'https://api.example.com',
    skipAuth: true
  })
  assert.equal(requests[2].url, 'https://api.example.com/api/v1/health')
  assert.equal(Object.hasOwn(requests[2].header, 'Authorization'), false)

  storedBaseUrl = 'not-a-url'
  await request({ url: '/health' })
  assert.equal(requests[3].url, 'http://127.0.0.1:8000/api/v1/health')

  console.log('真机 API 地址配置测试全部通过')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
