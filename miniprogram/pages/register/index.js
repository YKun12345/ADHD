const { request } = require('../../utils/request')
const {
  validateRegistration
} = require('../../utils/register-validation')
const {
  buildRegistrationPayload
} = require('../../utils/register-payload')
const {
  getRegistrationErrorMessage
} = require('../../utils/register-error')

const EDITABLE_FIELDS = [
  'fullName',
  'email',
  'age',
  'password',
  'confirmPassword'
]

Page({
  data: {
    fullName: '',
    email: '',
    patientType: '',
    age: '',
    gender: '',
    password: '',
    confirmPassword: '',
    consentAgreed: false,
    showPassword: false,
    showConfirmPassword: false,
    submitting: false
  },

  onFieldInput(event) {
    const field = event.currentTarget.dataset.field

    if (!EDITABLE_FIELDS.includes(field)) {
      return
    }

    this.setData({
      [field]: event.detail.value
    })
  },

  onPatientTypeSelect(event) {
    this.setData({
      patientType: event.currentTarget.dataset.value
    })
  },

  onGenderSelect(event) {
    this.setData({
      gender: event.currentTarget.dataset.value
    })
  },

  togglePasswordVisibility() {
    this.setData({
      showPassword: !this.data.showPassword
    })
  },

  toggleConfirmPasswordVisibility() {
    this.setData({
      showConfirmPassword: !this.data.showConfirmPassword
    })
  },

  onConsentChange(event) {
    this.setData({
      consentAgreed: event.detail.value.includes('agreed')
    })
  },

  showConsentSummary() {
    wx.showModal({
      title: '知情同意说明摘要',
      content:
        '平台会收集账号资料、患者基础资料、量表、认知测试和追踪数据，用于辅助筛查、任务安排和报告生成。平台结果不替代专业医生诊断。当前竞赛版本的正式文本仍需指导老师或相关专业人员审核。',
      showCancel: false,
      confirmText: '我知道了'
    })
  },

  goBackToLogin() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack({
        delta: 1
      })
      return
    }

    wx.reLaunch({
      url: '/pages/login/index'
    })
  },

  async handleSubmit() {
    if (this.data.submitting) {
      return
    }

    const validationMessage = validateRegistration(this.data)

    if (validationMessage) {
      wx.showToast({
        title: validationMessage,
        icon: 'none',
        duration: 2500
      })
      return
    }

    this.setData({
      submitting: true
    })

    try {
      const result = await request({
        url: '/auth/register',
        method: 'POST',
        data: buildRegistrationPayload(this.data)
      })

      if (!result || !result.access_token || !result.user) {
        const error = new Error('服务器未返回完整登录信息')
        error.code = 'INCOMPLETE_AUTH_RESPONSE'
        throw error
      }

      wx.setStorageSync('access_token', result.access_token)
      wx.setStorageSync('current_user', result.user)

      const app = getApp()
      app.globalData.isLoggedIn = true
      app.globalData.userInfo = result.user

      wx.showToast({
        title: '注册成功',
        icon: 'success'
      })

      wx.reLaunch({
        url: '/pages/home/index'
      })
    } catch (error) {
      this.setData({
        submitting: false
      })

      wx.showToast({
        title: getRegistrationErrorMessage(error),
        icon: 'none',
        duration: 2500
      })
    }
  }
})
