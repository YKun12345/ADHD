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
const {
  hasValidPatientSession,
  clearPatientData,
  replacePatientSession,
  reLaunchSafely
} = require('../../utils/session-privacy')
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

const EDITABLE_FIELDS = [
  'fullName',
  'email',
  'age',
  'password',
  'confirmPassword'
]
const SUBMIT_COOLDOWN_MS = 800

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

  onHide() {
    invalidateAuthAttempt(this)
  },

  onUnload() {
    invalidateAuthAttempt(this, false)
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
    invalidateAuthAttempt(this)
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack({
        delta: 1
      })
      return
    }

    reLaunchSafely(
      '/pages/login/index',
      '返回登录页失败，请重试'
    )
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

    const currentTime = Date.now()

    if (
      this._lastSubmitAt &&
      currentTime - this._lastSubmitAt < SUBMIT_COOLDOWN_MS
    ) {
      return
    }

    this._lastSubmitAt = currentTime

    this.setData({
      submitting: true
    })
    const authAttempt = beginAuthAttempt(this)
    let responseAccepted = false

    try {
      const result = await request({
        url: '/auth/register',
        method: 'POST',
        skipAuth: true,
        data: buildRegistrationPayload(this.data)
      })

      if (!isAuthAttemptCurrent(this, authAttempt)) {
        if (this._authAttemptId === authAttempt.id) {
          this.setData({ submitting: false })
        }
        return
      }
      responseAccepted = true

      if (!isValidAuthResult(result)) {
        const error = new Error('服务器未返回完整登录信息')
        error.code = 'INCOMPLETE_AUTH_RESPONSE'
        throw error
      }

      const currentUser = readStorageSafely('current_user')
      if (!isSamePatient(currentUser, result.user)) {
        const clearResult = clearPatientData()
        if (!clearResult.ok) {
          const clearError = new Error('本地患者数据清理失败，请重试')
          clearError.code = 'PATIENT_DATA_CLEAR_FAILED'
          throw clearError
        }
      }

      replacePatientSession(result)

      wx.showToast({
        title: '注册成功',
        icon: 'success'
      })

      reLaunchSafely(
        '/pages/home/index',
        '进入患者首页失败，请重试'
      )
    } catch (error) {
      if (
        !isAuthAttemptActive(this, authAttempt) ||
        (!responseAccepted && !isAuthAttemptCurrent(this, authAttempt))
      ) {
        return
      }
      this.setData({
        submitting: false
      })

      wx.showToast({
        title: (
          error.code === 'PATIENT_DATA_CLEAR_FAILED' ||
          error.code === 'SESSION_PREPARE_FAILED' ||
          error.code === 'SESSION_STORAGE_FAILED'
        ) ? error.message : getRegistrationErrorMessage(error),
        icon: 'none',
        duration: 2500
      })
    }
  }
})
