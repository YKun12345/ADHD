const { request } = require('../../utils/request')
const {
  clearPatientData,
  replacePatientSession,
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent,
  reLaunchSafely
} = require('../../utils/session-privacy')
const {
  hasValidRoleSession,
  hasValidAnySession,
  getRoleDestination
} = require('../../utils/role-session')
const {
  beginAuthAttempt,
  isAuthAttemptActive,
  isAuthAttemptCurrent,
  invalidateAuthAttempt
} = require('../../utils/auth-attempt')

function readStorageSafely(key) {
  try {
    return wx.getStorageSync(key)
  } catch (error) {
    return undefined
  }
}

function isValidAuthResult(result, expectedRole) {
  return Boolean(result) && hasValidRoleSession(expectedRole, (key) => (
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

function roleNavigationFailureTitle(role) {
  return role === 'researcher'
    ? '进入医生工作台失败，请重试'
    : '进入患者首页失败，请重试'
}

Page({
  data: {
    identifier: '',
    password: '',
    role: 'patient',
    submitting: false
  },

  onShow() {
    if (hasValidAnySession((key) => wx.getStorageSync(key))) {
      const currentUser = readStorageSafely('current_user')
      reLaunchSafely(
        getRoleDestination(currentUser),
        roleNavigationFailureTitle(currentUser && currentUser.role)
      )
    }
  },

  onHide() {
    invalidateAuthAttempt(this)
  },

  onUnload() {
    invalidateAuthAttempt(this, false)
  },

  onIdentifierInput(event) {
    if (this.data.submitting) return

    this.setData({
      identifier: event.detail.value
    })
  },

  onPasswordInput(event) {
    if (this.data.submitting) return

    this.setData({
      password: event.detail.value
    })
  },

  selectRole(event) {
    if (this.data.submitting) return
    const role = event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.role
      : ''
    if (role !== 'patient' && role !== 'researcher') return
    this.setData({ role })
  },

  goToRegister() {
    invalidateAuthAttempt(this)
    wx.navigateTo({
      url: '/pages/register/index'
    })
  },

  openServerSettings() {
    invalidateAuthAttempt(this)
    wx.navigateTo({
      url: '/pages/server-settings/index'
    })
  },

  async handleLogin() {
    if (this.data.submitting) return

    const identifier = this.data.identifier.trim()
    const password = this.data.password
    const role = this.data.role === 'researcher' ? 'researcher' : 'patient'

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
    const authAttempt = beginAuthAttempt(this)
    let responseAccepted = false

    try {
      const result = await request({
        url: '/auth/login',
        method: 'POST',
        skipAuth: true,
        data: {
          identifier,
          password,
          role
        }
      })

      if (!isAuthAttemptCurrent(this, authAttempt)) return
      responseAccepted = true

      if (!isValidAuthResult(result, role)) {
        throw new Error('服务器返回的账号身份不匹配')
      }

      const currentUser = readStorageSafely('current_user')
      if (role !== 'patient' || !isSamePatient(currentUser, result.user)) {
        const clearResult = clearPatientData()
        if (!clearResult.ok) {
          throw new Error('本地患者数据清理失败，请重试')
        }
      }

      replacePatientSession(result)
      const destinationLease = capturePatientSessionLease()

      wx.showToast({
        title: '登录成功',
        icon: 'success'
      })

      setTimeout(() => {
        if (
          !isAuthAttemptActive(this, authAttempt) ||
          !isPatientSessionLeaseCurrent(destinationLease)
        ) {
          return
        }
        reLaunchSafely(
          getRoleDestination(result.user),
          roleNavigationFailureTitle(result.user.role)
        )
      }, 600)
    } catch (error) {
      if (
        !isAuthAttemptActive(this, authAttempt) ||
        (!responseAccepted && !isAuthAttemptCurrent(this, authAttempt))
      ) {
        return
      }
      wx.showToast({
        title: error.message || '登录失败',
        icon: 'none',
        duration: 2500
      })
    } finally {
      if (this._authAttemptId === authAttempt.id) {
        this.setData({
          submitting: false
        })
      }
    }
  }
})
