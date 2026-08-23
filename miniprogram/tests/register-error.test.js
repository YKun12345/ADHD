const assert = require('node:assert/strict')

const {
  getRegistrationErrorMessage
} = require('../utils/register-error')
const {
  request,
  createTransportError
} = require('../utils/request')
const {
  SESSION_KEYS,
  PATIENT_DATA_KEYS
} = require('../utils/session-privacy')

function createHttpError(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function recordAssertion(failures, label, assertion) {
  try {
    assertion()
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

function createRequestBoundary(initialStorage, response, initialGlobalData) {
  const storage = Object.assign({}, initialStorage)
  const removedKeys = []
  const reLaunches = []
  const app = {
    globalData: Object.assign({}, initialGlobalData)
  }
  let requestOptions

  global.getApp = () => app
  global.wx = {
    getStorageSync(key) {
      return storage[key]
    },
    removeStorageSync(key) {
      removedKeys.push(key)
      delete storage[key]
    },
    reLaunch(options) {
      reLaunches.push(options)
    },
    request(options) {
      requestOptions = options
      options.success(response)
    }
  }

  return {
    app,
    storage,
    removedKeys,
    reLaunches,
    getRequestOptions() {
      return requestOptions
    }
  }
}

async function captureRequestRejection(options) {
  let rejection

  await assert.rejects(
    request(options),
    (error) => {
      rejection = error
      return true
    }
  )

  return rejection
}

async function run() {
  assert.equal(
    getRegistrationErrorMessage(
      createHttpError('This email is already registered.', 400)
    ),
    '该邮箱已经注册，请直接登录'
  )

  assert.equal(
    getRegistrationErrorMessage(
      createHttpError('[object Object]', 422)
    ),
    '填写信息格式不正确，请检查后重试'
  )

  assert.equal(
    getRegistrationErrorMessage(
      createHttpError(
        '密码不能为纯数字，请组合字母、数字或符号。',
        400
      )
    ),
    '密码不能为纯数字，请组合字母、数字或符号。'
  )

  const timeoutError = createTransportError({
    errMsg: 'request:fail timeout'
  })
  assert.equal(timeoutError.code, 'REQUEST_TIMEOUT')
  assert.equal(
    getRegistrationErrorMessage(timeoutError),
    '请求超时，请检查网络或后端服务'
  )

  const networkError = createTransportError({
    errMsg: 'request:fail network error'
  })
  assert.equal(networkError.code, 'NETWORK_ERROR')
  assert.equal(
    getRegistrationErrorMessage(networkError),
    '无法连接服务器，请检查后端是否启动'
  )

  const incompleteResponseError = new Error(
    '服务器未返回完整登录信息'
  )
  incompleteResponseError.code = 'INCOMPLETE_AUTH_RESPONSE'
  assert.equal(
    getRegistrationErrorMessage(incompleteResponseError),
    '服务器未返回完整登录信息'
  )

  assert.equal(
    getRegistrationErrorMessage(new Error('internal detail')),
    '注册失败，请稍后重试'
  )

  assert.equal(
    getRegistrationErrorMessage(null),
    '注册失败，请稍后重试'
  )

  const previousWx = global.wx
  const previousGetApp = global.getApp
  const failures = []

  try {
    const authenticatedStorage = {
      api_base_url: 'https://api.example.com/api/v1',
      access_token: 'patient-token',
      current_user: { id: 7 },
      ...Object.fromEntries(
        PATIENT_DATA_KEYS.map((key) => [key, { saved: true }])
      )
    }
    const authenticated = createRequestBoundary(
      authenticatedStorage,
      {
        statusCode: 401,
        data: { detail: '登录状态已过期，请重新登录' }
      },
      {
        isLoggedIn: true,
        userInfo: authenticatedStorage.current_user
      }
    )
    const authenticatedError = await captureRequestRejection({
      url: '/patient/dashboard_status'
    })

    recordAssertion(failures, '带 token 的 401 清理全部隐私键', () => {
      assert.deepEqual(
        authenticated.removedKeys,
        [...PATIENT_DATA_KEYS, ...SESSION_KEYS]
      )
    })
    recordAssertion(failures, '带 token 的 401 保留服务器地址', () => {
      assert.equal(
        authenticated.storage.api_base_url,
        'https://api.example.com/api/v1'
      )
    })
    recordAssertion(failures, '带 token 的 401 清除登录状态', () => {
      assert.equal(authenticated.app.globalData.isLoggedIn, false)
    })
    recordAssertion(failures, '带 token 的 401 清空内存用户', () => {
      assert.equal(authenticated.app.globalData.userInfo, null)
    })
    recordAssertion(failures, '带 token 的 401 只重启登录一次', () => {
      assert.deepEqual(authenticated.reLaunches, [
        { url: '/pages/login/index' }
      ])
    })
    recordAssertion(failures, '带 token 的业务请求携带 Authorization', () => {
      assert.equal(
        authenticated.getRequestOptions().header.Authorization,
        'Bearer patient-token'
      )
    })
    recordAssertion(failures, '带 token 的 401 保留后端错误详情', () => {
      assert.equal(authenticatedError.message, '登录状态已过期，请重新登录')
      assert.equal(authenticatedError.statusCode, 401)
    })

    const forbiddenStorage = {
      api_base_url: 'https://api.example.com/api/v1',
      access_token: 'patient-token',
      current_user: { id: 71 },
      patient_dashboard_cache: { saved: true }
    }
    const forbiddenSnapshot = Object.assign({}, forbiddenStorage)
    const forbidden = createRequestBoundary(
      forbiddenStorage,
      {
        statusCode: 403,
        data: { detail: '当前账号无权访问' }
      },
      {
        isLoggedIn: true,
        userInfo: forbiddenStorage.current_user
      }
    )
    const forbiddenError = await captureRequestRejection({
      url: '/patient/dashboard_status'
    })

    recordAssertion(failures, '带 token 的非 401 不清理缓存', () => {
      assert.deepEqual(forbidden.removedKeys, [])
      assert.deepEqual(forbidden.storage, forbiddenSnapshot)
    })
    recordAssertion(failures, '带 token 的非 401 不修改全局状态', () => {
      assert.equal(forbidden.app.globalData.isLoggedIn, true)
      assert.strictEqual(
        forbidden.app.globalData.userInfo,
        forbiddenStorage.current_user
      )
    })
    recordAssertion(failures, '带 token 的非 401 不跳转', () => {
      assert.deepEqual(forbidden.reLaunches, [])
    })
    recordAssertion(failures, '带 token 的非 401 仍保留认证头', () => {
      assert.equal(
        forbidden.getRequestOptions().header.Authorization,
        'Bearer patient-token'
      )
    })
    recordAssertion(failures, '带 token 的非 401 仍拒绝并保留错误', () => {
      assert.equal(forbiddenError.message, '当前账号无权访问')
      assert.equal(forbiddenError.statusCode, 403)
    })

    const skipAuthStorage = {
      api_base_url: 'https://api.example.com/api/v1',
      access_token: 'patient-token',
      current_user: { id: 8 },
      patient_dashboard_cache: { saved: true }
    }
    const skipAuthSnapshot = Object.assign({}, skipAuthStorage)
    const skipAuth = createRequestBoundary(
      skipAuthStorage,
      {
        statusCode: 401,
        data: { detail: '公开接口拒绝访问' }
      },
      {
        isLoggedIn: true,
        userInfo: skipAuthStorage.current_user
      }
    )
    const skipAuthError = await captureRequestRejection({
      url: '/auth/login',
      method: 'POST',
      skipAuth: true
    })

    recordAssertion(failures, 'skipAuth 401 不清理缓存', () => {
      assert.deepEqual(skipAuth.removedKeys, [])
      assert.deepEqual(skipAuth.storage, skipAuthSnapshot)
    })
    recordAssertion(failures, 'skipAuth 401 不修改全局状态', () => {
      assert.equal(skipAuth.app.globalData.isLoggedIn, true)
      assert.strictEqual(
        skipAuth.app.globalData.userInfo,
        skipAuthStorage.current_user
      )
    })
    recordAssertion(failures, 'skipAuth 401 不跳转', () => {
      assert.deepEqual(skipAuth.reLaunches, [])
    })
    recordAssertion(failures, 'skipAuth 请求不携带 Authorization', () => {
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          skipAuth.getRequestOptions().header,
          'Authorization'
        ),
        false
      )
    })
    recordAssertion(failures, 'skipAuth 401 仍拒绝并保留错误', () => {
      assert.equal(skipAuthError.message, '公开接口拒绝访问')
      assert.equal(skipAuthError.statusCode, 401)
    })

    const noTokenStorage = {
      api_base_url: 'https://api.example.com/api/v1',
      current_user: { id: 9 },
      patient_dashboard_cache: { saved: true }
    }
    const noTokenSnapshot = Object.assign({}, noTokenStorage)
    const noToken = createRequestBoundary(
      noTokenStorage,
      {
        statusCode: 401,
        data: { detail: '未提供访问令牌' }
      },
      {
        isLoggedIn: false,
        userInfo: noTokenStorage.current_user
      }
    )
    const noTokenError = await captureRequestRejection({
      url: '/auth/register',
      method: 'POST'
    })

    recordAssertion(failures, '无 token 的 401 不清理缓存', () => {
      assert.deepEqual(noToken.removedKeys, [])
      assert.deepEqual(noToken.storage, noTokenSnapshot)
    })
    recordAssertion(failures, '无 token 的 401 不修改全局状态', () => {
      assert.equal(noToken.app.globalData.isLoggedIn, false)
      assert.strictEqual(
        noToken.app.globalData.userInfo,
        noTokenStorage.current_user
      )
    })
    recordAssertion(failures, '无 token 的 401 不跳转', () => {
      assert.deepEqual(noToken.reLaunches, [])
    })
    recordAssertion(failures, '无 token 的 401 仍拒绝并保留错误', () => {
      assert.equal(noTokenError.message, '未提供访问令牌')
      assert.equal(noTokenError.statusCode, 401)
    })
  } finally {
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
    if (previousGetApp === undefined) delete global.getApp
    else global.getApp = previousGetApp
  }

  assert.deepEqual(
    failures,
    [],
    `请求会话回归失败：\n${failures.join('\n')}`
  )

  console.log('注册错误处理测试全部通过')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
