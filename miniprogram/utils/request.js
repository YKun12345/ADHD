const {
  API_BASE_URL_KEY,
  DEFAULT_API_BASE_URL,
  resolveApiBaseUrl
} = require('./api-config')
const { endPatientSession } = require('./session-privacy')

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

function request(options) {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('access_token')
    const storedBaseUrl = wx.getStorageSync(API_BASE_URL_KEY)
    const baseUrl = resolveApiBaseUrl(options.baseUrl || storedBaseUrl)

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
          resolve(response.data)
          return
        }

        const message =
          response.data && response.data.detail
            ? response.data.detail
            : `请求失败（${response.statusCode}）`

        if (response.statusCode === 401 && token && !options.skipAuth) {
          const currentToken = wx.getStorageSync('access_token')

          if (currentToken === token) {
            endPatientSession()
            wx.reLaunch({
              url: '/pages/login/index'
            })
          }
        }

        const error = new Error(message)
        error.statusCode = response.statusCode
        reject(error)
      },

      fail(error) {
        console.error('网络请求失败：', error)
        reject(createTransportError(error))
      }
    })
  })
}

module.exports = {
  request,
  BASE_URL,
  createTransportError
}
