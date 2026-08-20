const BASE_URL = 'http://127.0.0.1:8000/api/v1'

function request(options) {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('access_token')

    wx.request({
      url: `${BASE_URL}${options.url}`,
      method: options.method || 'GET',
      data: options.data || {},
      timeout: 10000,
      header: {
        'content-type': 'application/json',
        ...(token
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

        if (response.statusCode === 401 && token) {
          wx.removeStorageSync('access_token')
          wx.removeStorageSync('current_user')

          wx.reLaunch({
            url: '/pages/login/index'
          })
        }

        const error = new Error(message)
        error.statusCode = response.statusCode
        reject(error)
      },

      fail(error) {
        console.error('网络请求失败：', error)
        reject(new Error('无法连接服务器，请检查后端是否启动'))
      }
    })
  })
}

module.exports = {
  request,
  BASE_URL
}