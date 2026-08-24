const assert = require('node:assert/strict')

const {
  reLaunchSafely
} = require('../utils/safe-navigation')

const previousWx = global.wx
const reLaunches = []
const toasts = []
let reLaunchImplementation

global.wx = {
  reLaunch(options) {
    reLaunches.push(options)
    return reLaunchImplementation(options)
  },
  showToast(options) {
    toasts.push(options)
  }
}

try {
  reLaunchImplementation = () => undefined
  assert.equal(
    reLaunchSafely('/pages/home/index', '进入患者首页失败'),
    true
  )
  assert.equal(reLaunches.length, 1)
  assert.equal(reLaunches[0].url, '/pages/home/index')
  assert.equal(typeof reLaunches[0].fail, 'function')
  reLaunches[0].fail(new Error('async failure'))
  reLaunches[0].fail(new Error('duplicate failure'))
  assert.deepEqual(toasts, [{
    title: '进入患者首页失败',
    icon: 'none'
  }])

  reLaunches.length = 0
  toasts.length = 0
  reLaunchImplementation = () => {
    throw new Error('sync failure')
  }
  assert.equal(
    reLaunchSafely('/pages/home/index', '进入患者首页失败'),
    false
  )
  assert.equal(reLaunches.length, 1)
  assert.deepEqual(toasts, [{
    title: '进入患者首页失败',
    icon: 'none'
  }])
} finally {
  if (previousWx === undefined) delete global.wx
  else global.wx = previousWx
}

console.log('安全页面跳转测试全部通过')
