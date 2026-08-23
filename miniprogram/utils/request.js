const {
  API_BASE_URL_KEY,
  DEFAULT_API_BASE_URL,
  resolveApiBaseUrl
} = require('./api-config')
const {
  endPatientSession,
  getPatientDataRevision
} = require('./session-privacy')

const BASE_URL = DEFAULT_API_BASE_URL

function createTransportError(error = {}) {
  const detail =
    typeof error.errMsg === 'string' ? error.errMsg : ''
  const isTimeout = /timeout/i.test(detail)
  const requestError = new Error(
    isTimeout
      ? '请求超时，请检查网络或后端服务'
      : '无法连接服务器，请检查后端是否启动'
  )

  requestError.code = isTimeout
    ? 'REQUEST_TIMEOUT'
    : 'NETWORK_ERROR'

  return requestError
}

function createSessionChangedError(error) {
  const sessionError = new Error(
    error && typeof error.message === 'string' && error.message
      ? error.message
      : '会话已变更，请重新操作'
  )
  sessionError.code = 'SESSION_CHANGED'
  sessionError.sessionChanged = true

  if (error && error.statusCode !== undefined) {
    sessionError.statusCode = error.statusCode
  }
  if (error && error.code) {
    sessionError.originalCode = error.code
  }

  return sessionError
}

function isPatientSessionError(error) {
  return Boolean(error) && (
    error.code === 'SESSION_CHANGED' ||
    error.statusCode === 401
  )
}

function request(options) {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('access_token')
    const authenticated = Boolean(token && !options.skipAuth)
    const patientDataRevision = getPatientDataRevision()
    const storedBaseUrl = wx.getStorageSync(API_BASE_URL_KEY)
    const baseUrl = resolveApiBaseUrl(options.baseUrl || storedBaseUrl)

    const hasSessionChanged = () => {
      if (!authenticated) return false
      if (getPatientDataRevision() !== patientDataRevision) return true

      try {
        return wx.getStorageSync('access_token') !== token
      } catch (error) {
        return true
      }
    }

    wx.request({
      url: `${baseUrl}${options.url}`,
      method: options.method || 'GET',
      data: options.data || {},
      timeout: 10000,
      header: {
        'content-type': 'application/json',
        ...(token && !options.skipAuth
          ? {
              Authorization: `Bearer ${token}`
            }
          : {})
      },

      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (hasSessionChanged()) {
            reject(createSessionChangedError())
            return
          }
          resolve(response.data)
          return
        }

        const message =
          response.data && response.data.detail
            ? response.data.detail
            : `请求失败（${response.statusCode}）`

        const httpError = new Error(message)
        httpError.statusCode = response.statusCode

        if (response.statusCode === 401 && authenticated) {
          if (getPatientDataRevision() !== patientDataRevision) {
            reject(createSessionChangedError(httpError))
            return
          }

          let currentToken
          let tokenReadSucceeded = false

          try {
            currentToken = wx.getStorageSync('access_token')
            tokenReadSucceeded = true
          } catch (error) {
            // Without a current token, the active session cannot be confirmed.
          }

          if (tokenReadSucceeded && currentToken !== token) {
            reject(createSessionChangedError(httpError))
            return
          }

          if (tokenReadSucceeded && currentToken === token) {
            try {
              endPatientSession()
              wx.reLaunch({
                url: '/pages/login/index'
              })
            } catch (error) {
              // Session side effects must not replace the HTTP rejection.
            }
          }
        } else if (hasSessionChanged()) {
          reject(createSessionChangedError(httpError))
          return
        }

        reject(httpError)
      },

      fail(error) {
        console.error('网络请求失败：', error)
        const transportError = createTransportError(error)
        reject(
          hasSessionChanged()
            ? createSessionChangedError(transportError)
            : transportError
        )
      }
    })
  })
}

module.exports = {
  request,
  BASE_URL,
  createTransportError,
  createSessionChangedError,
  isPatientSessionError
}
