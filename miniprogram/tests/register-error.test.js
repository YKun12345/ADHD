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

function createRequestBoundary(
  initialStorage,
  response,
  initialGlobalData,
  settings = {}
) {
  const storage = Object.assign({}, initialStorage)
  const removedKeys = []
  const reLaunches = []
  const toasts = []
  const requestOptions = []
  let storageReadCount = 0
  const globalWrites = {
    isLoggedIn: [],
    userInfo: []
  }
  let isLoggedIn = initialGlobalData.isLoggedIn
  let userInfo = initialGlobalData.userInfo
  const globalData = {}

  Object.defineProperties(globalData, {
    isLoggedIn: {
      enumerable: true,
      get() {
        return isLoggedIn
      },
      set(value) {
        globalWrites.isLoggedIn.push(value)
        isLoggedIn = value
      }
    },
    userInfo: {
      enumerable: true,
      get() {
        return userInfo
      },
      set(value) {
        globalWrites.userInfo.push(value)
        userInfo = value
      }
    }
  })

  const app = {
    globalData
  }

  global.getApp = () => app
  global.wx = {
    getStorageSync(key) {
      storageReadCount += 1
      if (storageReadCount === settings.throwOnStorageRead) {
        throw new Error('storage unavailable')
      }
      return storage[key]
    },
    removeStorageSync(key) {
      removedKeys.push(key)
      if ((settings.failedRemovalKeys || []).includes(key)) {
        throw new Error(`cannot remove ${key}`)
      }
      delete storage[key]
    },
    reLaunch(options) {
      reLaunches.push(options)
      if (settings.reLaunchError) {
        throw settings.reLaunchError
      }
      if (
        settings.reLaunchFail &&
        typeof options.fail === 'function'
      ) {
        options.fail(new Error('reLaunch failed'))
      }
    },
    showToast(options) {
      toasts.push(options)
    },
    request(options) {
      requestOptions.push(options)
      if (!settings.deferResponse) {
        options.success(response)
      }
    }
  }

  return {
    app,
    globalWrites,
    storage,
    removedKeys,
    reLaunches,
    toasts,
    getStorageReadCount() {
      return storageReadCount
    },
    getRequestOptions(index = 0) {
      return requestOptions[index]
    },
    respond(index = 0, nextResponse = response) {
      requestOptions[index].success(nextResponse)
    }
  }
}

function captureCall(operation) {
  try {
    return { error: undefined, value: operation() }
  } catch (error) {
    return { error, value: undefined }
  }
}

function observePromise(promise) {
  let state = 'pending'
  let value

  promise.then(
    (result) => {
      state = 'resolved'
      value = result
    },
    (error) => {
      state = 'rejected'
      value = error
    }
  )

  return {
    getState() {
      return state
    },
    getValue() {
      return value
    }
  }
}

async function capturePromiseRejection(promise) {
  let rejection

  await assert.rejects(
    promise,
    (error) => {
      rejection = error
      return true
    }
  )

  return rejection
}

function captureRequestRejection(options) {
  return capturePromiseRejection(request(options))
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
      assert.equal(authenticated.reLaunches.length, 1)
      assert.equal(
        authenticated.reLaunches[0].url,
        '/pages/login/index'
      )
      assert.equal(
        typeof authenticated.reLaunches[0].fail,
        'function'
      )
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

    const staleStorage = {
      api_base_url: 'https://api.example.com/api/v1',
      access_token: 'old-token',
      current_user: { id: 'old-user' },
      ...Object.fromEntries(
        PATIENT_DATA_KEYS.map((key) => [key, { owner: 'old-user' }])
      )
    }
    const stale = createRequestBoundary(
      staleStorage,
      {
        statusCode: 401,
        data: { detail: '旧会话已经失效' }
      },
      {
        isLoggedIn: true,
        userInfo: staleStorage.current_user
      },
      { deferResponse: true }
    )
    const staleRejection = capturePromiseRejection(request({
      url: '/patient/dashboard_status'
    }))
    const newUser = { id: 'new-user' }
    const newPatientData = Object.fromEntries(
      PATIENT_DATA_KEYS.map((key) => [key, { owner: 'new-user' }])
    )
    Object.assign(stale.storage, newPatientData, {
      access_token: 'new-token',
      current_user: newUser
    })
    stale.app.globalData.isLoggedIn = true
    stale.app.globalData.userInfo = newUser
    stale.globalWrites.isLoggedIn.length = 0
    stale.globalWrites.userInfo.length = 0
    const newSessionSnapshot = Object.assign({}, stale.storage)

    stale.respond()
    const staleError = await staleRejection

    recordAssertion(failures, '旧 token 的延迟 401 不清理新会话', () => {
      assert.deepEqual(stale.removedKeys, [])
      assert.deepEqual(stale.storage, newSessionSnapshot)
    })
    recordAssertion(failures, '旧 token 的延迟 401 不修改新账号全局状态', () => {
      assert.deepEqual(stale.globalWrites.isLoggedIn, [])
      assert.deepEqual(stale.globalWrites.userInfo, [])
      assert.equal(stale.app.globalData.isLoggedIn, true)
      assert.strictEqual(stale.app.globalData.userInfo, newUser)
    })
    recordAssertion(failures, '旧 token 的延迟 401 不跳转', () => {
      assert.deepEqual(stale.reLaunches, [])
    })
    recordAssertion(failures, '旧 token 请求使用发送时认证头', () => {
      assert.equal(
        stale.getRequestOptions().header.Authorization,
        'Bearer old-token'
      )
    })
    recordAssertion(failures, '旧 token 的延迟 401 仍拒绝原错误', () => {
      assert.equal(staleError.message, '旧会话已经失效')
      assert.equal(staleError.statusCode, 401)
      assert.equal(staleError.code, 'SESSION_CHANGED')
    })

    const staleOriginStorage = {
      api_base_url: 'https://api-a.example.com/api/v1',
      access_token: 'same-token',
      current_user: { id: 70, role: 'patient' },
      ...Object.fromEntries(
        PATIENT_DATA_KEYS.map((key) => [key, { server: 'a' }])
      )
    }
    const staleOrigin = createRequestBoundary(
      staleOriginStorage,
      {
        statusCode: 401,
        data: { detail: '旧服务器拒绝了请求' }
      },
      {
        isLoggedIn: true,
        userInfo: staleOriginStorage.current_user
      },
      { deferResponse: true }
    )
    const staleOriginRejection = capturePromiseRejection(request({
      url: '/patient/dashboard_status'
    }))
    staleOrigin.storage.api_base_url = 'https://api-b.example.com/api/v1'
    staleOrigin.respond()
    const staleOriginError = await staleOriginRejection

    recordAssertion(failures, '旧服务器 401 不清理新来源会话', () => {
      assert.deepEqual(staleOrigin.removedKeys, [])
      assert.deepEqual(staleOrigin.reLaunches, [])
      assert.equal(staleOrigin.storage.access_token, 'same-token')
      assert.deepEqual(
        staleOrigin.storage.scale_latest_result,
        { server: 'a' }
      )
    })
    recordAssertion(failures, '旧服务器 401 标记为会话已变更', () => {
      assert.equal(staleOriginError.code, 'SESSION_CHANGED')
      assert.equal(staleOriginError.statusCode, 401)
      assert.equal(staleOriginError.message, '旧服务器拒绝了请求')
    })

    const concurrentStorage = {
      api_base_url: 'https://api.example.com/api/v1',
      access_token: 'shared-token',
      current_user: { id: 72 },
      ...Object.fromEntries(
        PATIENT_DATA_KEYS.map((key) => [key, { saved: true }])
      )
    }
    const concurrent = createRequestBoundary(
      concurrentStorage,
      undefined,
      {
        isLoggedIn: true,
        userInfo: concurrentStorage.current_user
      },
      { deferResponse: true }
    )
    const firstConcurrentRejection = capturePromiseRejection(request({
      url: '/patient/dashboard_status'
    }))
    const secondConcurrentRejection = capturePromiseRejection(request({
      url: '/patient/dashboard_status'
    }))

    concurrent.respond(0, {
      statusCode: 401,
      data: { detail: '第一个并发请求失效' }
    })
    const firstConcurrentError = await firstConcurrentRejection
    concurrent.respond(1, {
      statusCode: 401,
      data: { detail: '第二个并发请求失效' }
    })
    const secondConcurrentError = await secondConcurrentRejection

    recordAssertion(failures, '同 token 并发 401 只清理一次', () => {
      assert.deepEqual(
        concurrent.removedKeys,
        [...PATIENT_DATA_KEYS, ...SESSION_KEYS]
      )
      assert.deepEqual(concurrent.globalWrites.isLoggedIn, [false])
      assert.deepEqual(concurrent.globalWrites.userInfo, [null])
    })
    recordAssertion(failures, '同 token 并发 401 只跳转一次', () => {
      assert.equal(concurrent.reLaunches.length, 1)
      assert.equal(
        concurrent.reLaunches[0].url,
        '/pages/login/index'
      )
    })
    recordAssertion(failures, '同 token 并发请求使用相同认证头', () => {
      assert.equal(
        concurrent.getRequestOptions(0).header.Authorization,
        'Bearer shared-token'
      )
      assert.equal(
        concurrent.getRequestOptions(1).header.Authorization,
        'Bearer shared-token'
      )
    })
    recordAssertion(failures, '同 token 并发 401 都拒绝原错误', () => {
      assert.equal(firstConcurrentError.message, '第一个并发请求失效')
      assert.equal(firstConcurrentError.statusCode, 401)
      assert.equal(secondConcurrentError.message, '第二个并发请求失效')
      assert.equal(secondConcurrentError.statusCode, 401)
      assert.equal(secondConcurrentError.code, 'SESSION_CHANGED')
    })
    recordAssertion(failures, '同 token 并发清理保留服务器地址', () => {
      assert.deepEqual(concurrent.storage, {
        api_base_url: 'https://api.example.com/api/v1'
      })
    })

    const storageFailureStorage = {
      api_base_url: 'https://api.example.com/api/v1',
      access_token: 'storage-failure-token',
      current_user: { id: 73 },
      ...Object.fromEntries(
        PATIENT_DATA_KEYS.map((key) => [key, { saved: true }])
      )
    }
    const storageFailureSnapshot = Object.assign({}, storageFailureStorage)
    const storageFailure = createRequestBoundary(
      storageFailureStorage,
      {
        statusCode: 401,
        data: { detail: '存储读取期间会话失效' }
      },
      {
        isLoggedIn: true,
        userInfo: storageFailureStorage.current_user
      },
      {
        deferResponse: true,
        throwOnStorageRead: 3
      }
    )
    const storageFailureObservation = observePromise(request({
      url: '/patient/dashboard_status'
    }))
    const storageFailureCallback = captureCall(() => {
      storageFailure.respond()
    })
    await Promise.resolve()
    await Promise.resolve()

    recordAssertion(failures, '响应时 storage 读取失败不抛出 callback', () => {
      assert.equal(storageFailureCallback.error, undefined)
      assert.equal(storageFailure.getStorageReadCount(), 3)
    })
    recordAssertion(failures, '响应时 storage 读取失败仍拒绝原 401', () => {
      assert.equal(storageFailureObservation.getState(), 'rejected')
      assert.equal(
        storageFailureObservation.getValue().message,
        '存储读取期间会话失效'
      )
      assert.equal(storageFailureObservation.getValue().statusCode, 401)
    })
    recordAssertion(failures, '无法确认当前 token 时不做破坏性退出', () => {
      assert.deepEqual(storageFailure.removedKeys, [])
      assert.deepEqual(storageFailure.reLaunches, [])
      assert.deepEqual(storageFailure.storage, storageFailureSnapshot)
      assert.deepEqual(storageFailure.globalWrites.isLoggedIn, [])
      assert.deepEqual(storageFailure.globalWrites.userInfo, [])
    })

    const cleanupFailureStorage = {
      api_base_url: 'https://api.example.com/api/v1',
      access_token: 'cleanup-failure-token',
      current_user: { id: 75, role: 'patient' },
      ...Object.fromEntries(
        PATIENT_DATA_KEYS.map((key) => [key, { saved: true }])
      )
    }
    const cleanupFailure = createRequestBoundary(
      cleanupFailureStorage,
      {
        statusCode: 401,
        data: { detail: '登录状态已失效' }
      },
      {
        isLoggedIn: true,
        userInfo: cleanupFailureStorage.current_user
      },
      {
        failedRemovalKeys: SESSION_KEYS
      }
    )
    const cleanupFailureError = await captureRequestRejection({
      url: '/patient/dashboard_status'
    })

    recordAssertion(failures, '401 凭证清理失败时不进入登录重定向循环', () => {
      assert.deepEqual(cleanupFailure.reLaunches, [])
      assert.equal(
        cleanupFailure.storage.access_token,
        'cleanup-failure-token'
      )
      assert.deepEqual(
        cleanupFailure.storage.current_user,
        { id: 75, role: 'patient' }
      )
    })
    recordAssertion(failures, '401 凭证清理失败时提示用户关闭重试', () => {
      assert.match(cleanupFailure.toasts.at(-1).title, /清理失败/)
    })
    recordAssertion(failures, '401 凭证清理失败仍拒绝原始请求', () => {
      assert.equal(cleanupFailureError.message, '登录状态已失效')
      assert.equal(cleanupFailureError.statusCode, 401)
    })

    const reLaunchFailureStorage = {
      api_base_url: 'https://api.example.com/api/v1',
      access_token: 'relaunch-failure-token',
      current_user: { id: 74 },
      ...Object.fromEntries(
        PATIENT_DATA_KEYS.map((key) => [key, { saved: true }])
      )
    }
    const reLaunchFailure = createRequestBoundary(
      reLaunchFailureStorage,
      {
        statusCode: 401,
        data: { detail: '跳转期间会话失效' }
      },
      {
        isLoggedIn: true,
        userInfo: reLaunchFailureStorage.current_user
      },
      {
        deferResponse: true,
        reLaunchError: new Error('reLaunch unavailable')
      }
    )
    const reLaunchFailureObservation = observePromise(request({
      url: '/patient/dashboard_status'
    }))
    const reLaunchFailureCallback = captureCall(() => {
      reLaunchFailure.respond()
    })
    await Promise.resolve()
    await Promise.resolve()

    recordAssertion(failures, 'reLaunch 同步失败不抛出 callback', () => {
      assert.equal(reLaunchFailureCallback.error, undefined)
    })
    recordAssertion(failures, 'reLaunch 同步失败仍拒绝原 401', () => {
      assert.equal(reLaunchFailureObservation.getState(), 'rejected')
      assert.equal(
        reLaunchFailureObservation.getValue().message,
        '跳转期间会话失效'
      )
      assert.equal(reLaunchFailureObservation.getValue().statusCode, 401)
    })
    recordAssertion(failures, 'reLaunch 同步失败前已完成单次清理', () => {
      assert.deepEqual(
        reLaunchFailure.removedKeys,
        [...PATIENT_DATA_KEYS, ...SESSION_KEYS]
      )
      assert.deepEqual(reLaunchFailure.globalWrites.isLoggedIn, [false])
      assert.deepEqual(reLaunchFailure.globalWrites.userInfo, [null])
      assert.equal(reLaunchFailure.reLaunches.length, 1)
      assert.equal(
        reLaunchFailure.reLaunches[0].url,
        '/pages/login/index'
      )
      assert.deepEqual(reLaunchFailure.storage, {
        api_base_url: 'https://api.example.com/api/v1'
      })
    })

    const asyncReLaunchFailureStorage = {
      api_base_url: 'https://api.example.com/api/v1',
      access_token: 'async-relaunch-failure-token',
      current_user: { id: 76, role: 'patient' }
    }
    const asyncReLaunchFailure = createRequestBoundary(
      asyncReLaunchFailureStorage,
      {
        statusCode: 401,
        data: { detail: '异步跳转期间会话失效' }
      },
      {
        isLoggedIn: true,
        userInfo: asyncReLaunchFailureStorage.current_user
      },
      {
        reLaunchFail: true
      }
    )
    const asyncReLaunchFailureError = await captureRequestRejection({
      url: '/patient/dashboard_status'
    })

    recordAssertion(failures, 'reLaunch 异步失败仍拒绝原始 401', () => {
      assert.equal(
        asyncReLaunchFailureError.message,
        '异步跳转期间会话失效'
      )
      assert.equal(asyncReLaunchFailureError.statusCode, 401)
    })
    recordAssertion(failures, 'reLaunch 异步失败显示恢复提示', () => {
      assert.equal(asyncReLaunchFailure.reLaunches.length, 1)
      assert.match(
        asyncReLaunchFailure.toasts.at(-1).title,
        /返回登录页失败/
      )
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
