const {
  API_BASE_URL_KEY,
  DEFAULT_API_BASE_URL,
  normalizeApiBaseUrl,
  resolveApiBaseUrl
} = require('../../utils/api-config')
const { request } = require('../../utils/request')
const {
  endPatientSession,
  hasValidPatientSession,
  capturePatientDataLease,
  isPatientDataLeaseCurrent,
  reLaunchSafely
} = require('../../utils/session-privacy')

const ENVIRONMENT_LABELS = {
  local: '本机开发',
  lan: '局域网调试',
  secure: 'HTTPS 正式环境'
}

function addressState(value) {
  const address = resolveApiBaseUrl(value)
  const normalized = normalizeApiBaseUrl(address)

  return {
    address,
    environment: normalized.environment,
    environmentLabel: ENVIRONMENT_LABELS[normalized.environment] || '未识别环境'
  }
}

function prepareOriginChange(nextAddress) {
  const currentAddress = resolveApiBaseUrl(
    wx.getStorageSync(API_BASE_URL_KEY)
  )
  if (currentAddress === nextAddress) return false

  const cleanupResult = endPatientSession()
  if (!cleanupResult.ok) {
    const cleanupError = new Error(
      '切换服务器前本地会话清理失败，请重试'
    )
    cleanupError.returnToLogin = !hasValidPatientSession()
    throw cleanupError
  }
  return true
}

function returnToLoginIfChanged(changed) {
  if (!changed) return false
  return reLaunchSafely(
    '/pages/login/index',
    '返回登录页失败，请关闭小程序后重试'
  )
}

function beginConnectionAttempt(page, address) {
  const id = (page._connectionAttemptId || 0) + 1
  page._connectionAttemptId = id
  page._serverSettingsActive = true
  return {
    id,
    address,
    lease: capturePatientDataLease()
  }
}

function isConnectionAttemptActive(page, attempt) {
  return Boolean(page) &&
    Boolean(attempt) &&
    page._serverSettingsActive === true &&
    page._connectionAttemptId === attempt.id
}

function isConnectionAttemptCurrent(page, attempt) {
  return isConnectionAttemptActive(page, attempt) &&
    isPatientDataLeaseCurrent(attempt.lease) &&
    normalizeApiBaseUrl(page.data.address).value === attempt.address
}

function invalidateConnectionAttempt(page, resetTesting = true) {
  page._serverSettingsActive = false
  page._connectionAttemptId = (page._connectionAttemptId || 0) + 1

  if (
    resetTesting &&
    page.data &&
    page.data.testing === true &&
    typeof page.setData === 'function'
  ) {
    page.setData({ testing: false })
  }
}

Page({
  data: {
    ...addressState(DEFAULT_API_BASE_URL),
    testing: false,
    statusType: '',
    statusMessage: ''
  },

  onLoad() {
    this._serverSettingsActive = true
    const storedAddress = wx.getStorageSync(API_BASE_URL_KEY)
    this.setData({
      ...addressState(storedAddress),
      statusType: '',
      statusMessage: ''
    })
  },

  onShow() {
    this._serverSettingsActive = true
  },

  onHide() {
    invalidateConnectionAttempt(this)
  },

  onUnload() {
    invalidateConnectionAttempt(this, false)
  },

  onAddressInput(event) {
    invalidateConnectionAttempt(this, false)
    this.setData({
      address: event.detail.value,
      testing: false,
      environment: '',
      environmentLabel: '等待检测',
      statusType: '',
      statusMessage: ''
    })
  },

  async testAndSave() {
    if (this.data.testing) return

    const normalized = normalizeApiBaseUrl(this.data.address)
    if (normalized.error) {
      this.setData({
        statusType: 'error',
        statusMessage: normalized.error
      })
      wx.showToast({ title: normalized.error, icon: 'none' })
      return
    }

    this.setData({
      testing: true,
      statusType: '',
      statusMessage: '正在检查服务器连接…'
    })
    const attempt = beginConnectionAttempt(this, normalized.value)
    let responseAccepted = false

    try {
      const response = await request({
        url: '/health',
        method: 'GET',
        baseUrl: normalized.value,
        skipAuth: true
      })

      if (!isConnectionAttemptCurrent(this, attempt)) return
      responseAccepted = true

      if (!response || response.status !== 'ok') {
        throw new Error('服务器健康检查未通过')
      }

      const originChanged = prepareOriginChange(normalized.value)
      wx.setStorageSync(API_BASE_URL_KEY, normalized.value)
      this.setData({
        address: normalized.value,
        environment: normalized.environment,
        environmentLabel: ENVIRONMENT_LABELS[normalized.environment],
        statusType: 'success',
        statusMessage: '连接成功，服务器地址已保存'
      })
      wx.showToast({ title: '连接成功', icon: 'success' })
      returnToLoginIfChanged(originChanged)
    } catch (error) {
      if (
        !isConnectionAttemptActive(this, attempt) ||
        (!responseAccepted && !isConnectionAttemptCurrent(this, attempt))
      ) {
        return
      }
      this.setData({
        statusType: 'error',
        statusMessage: error.message || '服务器连接失败'
      })
      wx.showToast({
        title: error.message || '服务器连接失败',
        icon: 'none'
      })
      if (error.returnToLogin) {
        returnToLoginIfChanged(true)
      }
    } finally {
      if (this._connectionAttemptId === attempt.id) {
        this.setData({ testing: false })
      }
    }
  },

  restoreDefault() {
    invalidateConnectionAttempt(this)
    try {
      const originChanged = prepareOriginChange(DEFAULT_API_BASE_URL)
      wx.removeStorageSync(API_BASE_URL_KEY)
      this.setData({
        ...addressState(DEFAULT_API_BASE_URL),
        testing: false,
        statusType: 'success',
        statusMessage: '已恢复开发者工具默认地址'
      })
      wx.showToast({ title: '已恢复默认地址', icon: 'success' })
      returnToLoginIfChanged(originChanged)
    } catch (error) {
      this.setData({
        statusType: 'error',
        statusMessage: error.message || '恢复默认地址失败'
      })
      wx.showToast({
        title: error.message || '恢复默认地址失败',
        icon: 'none'
      })
      if (error.returnToLogin) {
        returnToLoginIfChanged(true)
      }
    }
  },

  goBack() {
    invalidateConnectionAttempt(this)
    wx.navigateBack({ delta: 1 })
  }
})
