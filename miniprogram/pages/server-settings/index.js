const {
  API_BASE_URL_KEY,
  DEFAULT_API_BASE_URL,
  normalizeApiBaseUrl,
  resolveApiBaseUrl
} = require('../../utils/api-config')
const { request } = require('../../utils/request')

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

Page({
  data: {
    ...addressState(DEFAULT_API_BASE_URL),
    testing: false,
    statusType: '',
    statusMessage: ''
  },

  onLoad() {
    const storedAddress = wx.getStorageSync(API_BASE_URL_KEY)
    this.setData({
      ...addressState(storedAddress),
      statusType: '',
      statusMessage: ''
    })
  },

  onAddressInput(event) {
    this.setData({
      address: event.detail.value,
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

    try {
      const response = await request({
        url: '/health',
        method: 'GET',
        baseUrl: normalized.value,
        skipAuth: true
      })

      if (!response || response.status !== 'ok') {
        throw new Error('服务器健康检查未通过')
      }

      wx.setStorageSync(API_BASE_URL_KEY, normalized.value)
      this.setData({
        address: normalized.value,
        environment: normalized.environment,
        environmentLabel: ENVIRONMENT_LABELS[normalized.environment],
        statusType: 'success',
        statusMessage: '连接成功，服务器地址已保存'
      })
      wx.showToast({ title: '连接成功', icon: 'success' })
    } catch (error) {
      this.setData({
        statusType: 'error',
        statusMessage: error.message || '服务器连接失败'
      })
      wx.showToast({
        title: error.message || '服务器连接失败',
        icon: 'none'
      })
    } finally {
      this.setData({ testing: false })
    }
  },

  restoreDefault() {
    wx.removeStorageSync(API_BASE_URL_KEY)
    this.setData({
      ...addressState(DEFAULT_API_BASE_URL),
      testing: false,
      statusType: 'success',
      statusMessage: '已恢复开发者工具默认地址'
    })
    wx.showToast({ title: '已恢复默认地址', icon: 'success' })
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})
