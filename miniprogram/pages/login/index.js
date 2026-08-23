const { request } = require('../../utils/request')
const {
  hasValidPatientSession,
  clearPatientData,
  endPatientSession,
  advancePatientDataRevision
} = require('../../utils/session-privacy')

function readStorageSafely(key) {
  try {
    return wx.getStorageSync(key)
  } catch (error) {
    return undefined
  }
}

function isValidAuthResult(result) {
  return Boolean(result) && hasValidPatientSession((key) => (
    key === 'access_token' ? result.access_token : result.user
  ))
}

function isSamePatient(currentUser, nextUser) {
  return currentUser &&
    currentUser.role === 'patient' &&
    Number.isInteger(currentUser.id) &&
    currentUser.id > 0 &&
    currentUser.id === nextUser.id
}

function updateAppSession(user) {
  try {
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.isLoggedIn = true
      app.globalData.userInfo = user
    }
  } catch (error) {
    // Storage remains the source of truth if the app instance is unavailable.
  }
}

function storeSession(result) {
  try {
    wx.setStorageSync('current_user', result.user)
    wx.setStorageSync('access_token', result.access_token)
  } catch (error) {
    const rollbackResult = endPatientSession({ includePatientData: false })
    const storageError = new Error(
      rollbackResult.ok
        ? '登录凭证保存失败，请重试'
        : '登录凭证保存及回滚失败，请关闭小程序后重试'
    )
    storageError.code = 'SESSION_STORAGE_FAILED'
    storageError.failedKeys = rollbackResult.failedKeys
    storageError.failedPageCount = rollbackResult.failedPageCount
    throw storageError
  }
}

Page({
  data: {
    identifier: '',
    password: '',
    submitting: false
  },

  onShow() {
    if (hasValidPatientSession((key) => wx.getStorageSync(key))) {
      wx.reLaunch({
        url: '/pages/home/index'
      })
    }
  },

  onIdentifierInput(event) {
    this.setData({
      identifier: event.detail.value
    })
  },

  onPasswordInput(event) {
    this.setData({
      password: event.detail.value
    })
  },

  goToRegister() {
    wx.navigateTo({
      url: '/pages/register/index'
    })
  },

  openServerSettings() {
    wx.navigateTo({
      url: '/pages/server-settings/index'
    })
  },

  async handleLogin() {
    const identifier = this.data.identifier.trim()
    const password = this.data.password

    if (!identifier) {
      wx.showToast({
        title: '请输入账号',
        icon: 'none'
      })
      return
    }

    if (identifier.length < 3) {
      wx.showToast({
        title: '账号至少需要3个字符',
        icon: 'none'
      })
      return
    }

    if (!password) {
      wx.showToast({
        title: '请输入密码',
        icon: 'none'
      })
      return
    }

    if (password.length < 6) {
      wx.showToast({
        title: '密码至少需要6个字符',
        icon: 'none'
      })
      return
    }

    this.setData({
      submitting: true
    })

    try {
      const result = await request({
        url: '/auth/login',
        method: 'POST',
        skipAuth: true,
        data: {
          identifier,
          password,
          role: 'patient'
        }
      })

      if (!isValidAuthResult(result)) {
        throw new Error('服务器未返回登录凭证')
      }

      const currentUser = readStorageSafely('current_user')
      if (!isSamePatient(currentUser, result.user)) {
        const clearResult = clearPatientData()
        if (!clearResult.ok) {
          throw new Error('本地患者数据清理失败，请重试')
        }
      }

      storeSession(result)
      advancePatientDataRevision()
      updateAppSession(result.user)

      wx.showToast({
        title: '登录成功',
        icon: 'success'
      })

      setTimeout(() => {
        wx.reLaunch({
          url: '/pages/home/index'
        })
      }, 600)
    } catch (error) {
      wx.showToast({
        title: error.message || '登录失败',
        icon: 'none',
        duration: 2500
      })
    } finally {
      this.setData({
        submitting: false
      })
    }
  }
})
