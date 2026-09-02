const assert = require('node:assert/strict')

const requestModulePath = require.resolve('../utils/request')
const pageModulePath = require.resolve('../pages/login/index')

require.cache[requestModulePath] = {
  id: requestModulePath,
  filename: requestModulePath,
  loaded: true,
  exports: {
    request() {
      throw new Error('本测试不应发送登录请求')
    }
  }
}

let pageDefinition
let storage = {}
const reLaunchCalls = []
const navigateToCalls = []

global.Page = (definition) => {
  pageDefinition = definition
}

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  reLaunch(options) {
    reLaunchCalls.push(options)
  },
  navigateTo(options) {
    navigateToCalls.push(options)
  }
}

delete require.cache[pageModulePath]
require(pageModulePath)

assert.equal(
  typeof pageDefinition.onShow,
  'function',
  '登录页面缺少已登录会话恢复逻辑'
)

storage = {
  access_token: 'existing-token',
  current_user: {
    id: 1,
    role: 'patient',
    full_name: '会话恢复患者'
  }
}
pageDefinition.onShow()
assert.equal(reLaunchCalls.length, 1)
assert.equal(reLaunchCalls[0].url, '/pages/home/index')
assert.equal(typeof reLaunchCalls[0].fail, 'function')

reLaunchCalls.length = 0
storage = {
  access_token: 'doctor-token',
  current_user: {
    id: 2,
    role: 'researcher',
    full_name: '李医生'
  }
}
pageDefinition.onShow()
assert.equal(reLaunchCalls.length, 1)
assert.equal(reLaunchCalls[0].url, '/pages/doctor-home/index')

reLaunchCalls.length = 0
storage = {
  access_token: 'orphan-token'
}
pageDefinition.onShow()
assert.equal(
  reLaunchCalls.length,
  0,
  '缺少患者资料时应保留在登录页'
)

reLaunchCalls.length = 0
storage = {
  current_user: {
    full_name: '缺少 token 的患者'
  }
}
pageDefinition.onShow()
assert.equal(
  reLaunchCalls.length,
  0,
  '缺少 token 时应保留在登录页'
)

assert.equal(
  typeof pageDefinition.openServerSettings,
  'function',
  '登录页缺少服务器设置入口控制逻辑'
)
pageDefinition.openServerSettings()
assert.deepEqual(navigateToCalls, [
  { url: '/pages/server-settings/index' }
])

console.log('登录页面会话恢复测试全部通过')
