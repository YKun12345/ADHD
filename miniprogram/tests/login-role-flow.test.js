const assert = require('node:assert/strict')

const calls = { requests: [], toasts: [], reLaunches: [] }
let storage = {}
let response = null
let pageDefinition
const app = { globalData: { isLoggedIn: false, userInfo: null } }

const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = {
  id: requestPath,
  filename: requestPath,
  loaded: true,
  exports: {
    async request(options) {
      calls.requests.push(options)
      return response
    }
  }
}

global.getApp = () => app
global.getCurrentPages = () => []
global.Page = (definition) => {
  pageDefinition = definition
}
global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  setStorageSync(key, value) {
    storage[key] = value
  },
  removeStorageSync(key) {
    delete storage[key]
  },
  showToast(options) {
    calls.toasts.push(options)
  },
  reLaunch(options) {
    calls.reLaunches.push(options)
  },
  navigateTo() {}
}

const nativeSetTimeout = global.setTimeout
global.setTimeout = (callback) => {
  callback()
  return 1
}

require('../pages/login/index')

function createPage() {
  return {
    ...pageDefinition,
    data: { ...pageDefinition.data },
    setData(patch) {
      this.data = { ...this.data, ...patch }
    }
  }
}

async function run() {
  response = {
    access_token: 'doctor-token',
    user: { id: 3, role: 'researcher', full_name: '李医生' }
  }
  const doctorLogin = createPage()
  doctorLogin.selectRole({ currentTarget: { dataset: { role: 'researcher' } } })
  doctorLogin.setData({ identifier: 'doctor@demo.com', password: 'Demo#2026' })
  await doctorLogin.handleLogin()

  assert.equal(calls.requests.length, 1)
  assert.equal(calls.requests[0].data.role, 'researcher')
  assert.equal(storage.current_user.role, 'researcher')
  assert.equal(app.globalData.userInfo.role, 'researcher')
  assert.equal(calls.reLaunches[0].url, '/pages/doctor-home/index')

  storage = {}
  calls.requests = []
  calls.toasts = []
  calls.reLaunches = []
  response = {
    access_token: 'patient-token',
    user: { id: 9, role: 'patient', full_name: '患者乙' }
  }
  const mismatchedLogin = createPage()
  mismatchedLogin.selectRole({ currentTarget: { dataset: { role: 'researcher' } } })
  mismatchedLogin.setData({ identifier: 'doctor@demo.com', password: 'Demo#2026' })
  await mismatchedLogin.handleLogin()

  assert.equal(storage.access_token, undefined)
  assert.equal(storage.current_user, undefined)
  assert.equal(calls.reLaunches.length, 0)
  assert.equal(
    calls.toasts.some((item) => item.title === '服务器返回的账号身份不匹配'),
    true
  )

  console.log('登录角色选择与响应身份校验测试全部通过')
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    global.setTimeout = nativeSetTimeout
  })
