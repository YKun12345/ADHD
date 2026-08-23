const assert = require('node:assert/strict')

const {
  SESSION_KEYS,
  PATIENT_DATA_KEYS
} = require('../utils/session-privacy')

const appModulePath = require.resolve('../app')
const previousApp = global.App
const previousWx = global.wx
const previousGetApp = global.getApp
let appDefinition

function recordAssertion(failures, label, assertion) {
  try {
    assertion()
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

function launchWith(initialStorage, options = {}) {
  const storage = Object.assign({}, initialStorage)
  const removedKeys = []
  const reLaunches = []
  const readCounts = {}

  global.wx = {
    getStorageSync(key) {
      readCounts[key] = (readCounts[key] || 0) + 1
      if (
        options.throwOnRepeatedCurrentUserRead &&
        key === 'current_user' &&
        readCounts[key] > 1
      ) {
        throw new Error('current_user changed during launch')
      }
      return storage[key]
    },
    removeStorageSync(key) {
      removedKeys.push(key)
      delete storage[key]
    },
    reLaunch(options) {
      reLaunches.push(options)
    }
  }
  global.getApp = () => {
    throw new Error('App 启动期间不应依赖 getApp() 更新当前实例')
  }

  appDefinition.globalData = {
    isLoggedIn: true,
    userInfo: { id: 'stale-user' }
  }
  appDefinition.onLaunch()

  return {
    app: appDefinition,
    storage,
    readCounts,
    removedKeys,
    reLaunches
  }
}

function run() {
  const failures = []

  try {
    global.App = (definition) => {
      appDefinition = definition
    }
    delete require.cache[appModulePath]
    require(appModulePath)

    assert.ok(appDefinition, 'app.js 未注册 App 定义')
    assert.equal(
      typeof appDefinition.onLaunch,
      'function',
      'app.js 缺少 onLaunch 会话恢复逻辑'
    )

    const currentUser = {
      id: 7,
      role: 'patient',
      full_name: '会话恢复患者'
    }
    const validSession = launchWith({
      api_base_url: 'https://api.example.com/api/v1',
      access_token: '  patient-token  ',
      current_user: currentUser,
      patient_dashboard_cache: { saved: true }
    }, {
      throwOnRepeatedCurrentUserRead: true
    })

    recordAssertion(failures, '有效会话恢复登录状态', () => {
      assert.equal(validSession.app.globalData.isLoggedIn, true)
      assert.strictEqual(validSession.app.globalData.userInfo, currentUser)
      assert.equal(validSession.readCounts.access_token, 1)
      assert.equal(validSession.readCounts.current_user, 1)
    })
    recordAssertion(failures, '有效会话不清理本地数据', () => {
      assert.deepEqual(validSession.removedKeys, [])
      assert.deepEqual(validSession.storage.patient_dashboard_cache, {
        saved: true
      })
      assert.equal(
        validSession.storage.api_base_url,
        'https://api.example.com/api/v1'
      )
    })
    recordAssertion(failures, '有效会话启动不跳转', () => {
      assert.deepEqual(validSession.reLaunches, [])
    })

    const invalidFixtures = [
      {
        name: '只有 token',
        storage: {
          access_token: 'orphan-token',
          patient_dashboard_cache: { saved: true }
        }
      },
      {
        name: '只有用户资料',
        storage: {
          current_user: { id: 8 }
        }
      },
      {
        name: '空白 token',
        storage: {
          access_token: '   ',
          current_user: { id: 9 }
        }
      },
      {
        name: '数组用户资料',
        storage: {
          access_token: 'patient-token',
          current_user: [{ id: 10 }]
        }
      },
      {
        name: 'empty-content user',
        storage: {
          access_token: 'patient-token',
          current_user: { full_name: '   ' }
        }
      },
      {
        name: '完全无会话',
        storage: {}
      }
    ]

    for (const fixture of invalidFixtures) {
      const launched = launchWith(Object.assign({
        api_base_url: 'https://api.example.com/api/v1'
      }, fixture.storage))

      recordAssertion(failures, `${fixture.name}重置内存会话`, () => {
        assert.equal(launched.app.globalData.isLoggedIn, false)
        assert.equal(launched.app.globalData.userInfo, null)
      })
      recordAssertion(failures, `${fixture.name}尝试清理全部隐私键`, () => {
        assert.deepEqual(
          launched.removedKeys,
          [...PATIENT_DATA_KEYS, ...SESSION_KEYS]
        )
      })
      recordAssertion(failures, `${fixture.name}保留服务器地址`, () => {
        assert.equal(
          launched.storage.api_base_url,
          'https://api.example.com/api/v1'
        )
      })
      recordAssertion(failures, `${fixture.name}启动不跳转`, () => {
        assert.deepEqual(launched.reLaunches, [])
      })

      if (fixture.name === '只有 token') {
        recordAssertion(failures, '无效会话实际删除患者缓存', () => {
          assert.equal(
            Object.prototype.hasOwnProperty.call(
              launched.storage,
              'patient_dashboard_cache'
            ),
            false
          )
        })
      }
    }
  } finally {
    delete require.cache[appModulePath]
    if (previousApp === undefined) delete global.App
    else global.App = previousApp
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
    if (previousGetApp === undefined) delete global.getApp
    else global.getApp = previousGetApp
  }

  assert.deepEqual(
    failures,
    [],
    `App 会话启动回归失败：\n${failures.join('\n')}`
  )

  console.log('App 会话启动测试全部通过')
}

run()
