const { registerPatientPage } = require('../../utils/patient-page')
const { request } = require('../../utils/request')
const {
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
} = require('../../utils/session-privacy')
const asrsScale = require('../../utils/asrs-scale')
const snapScale = require('../../utils/snap-scale')
const {
  SCALE_LATEST_RESULT_KEY,
  isReportableScaleResult
} = require('../../utils/report-data')

const SCALE_MODELS = {
  adult: {
    draftKey: asrsScale.ASRS_DRAFT_KEY,
    config: asrsScale.ASRS_CONFIG,
    instructions: '请根据近 6 个月的实际情况作答',
    scaleKicker: '行为量表 · 成人版',
    normalizeDraftAnswers: asrsScale.normalizeDraftAnswers,
    setAnswer: asrsScale.setAnswer,
    getQuestionState: asrsScale.getQuestionState,
    buildScalePayload: asrsScale.buildScalePayload
  },
  child: {
    draftKey: snapScale.SNAP_DRAFT_KEY,
    config: snapScale.SNAP_CONFIG,
    instructions: snapScale.SNAP_CONFIG.instructions,
    scaleKicker: '行为量表 · 儿童版',
    normalizeDraftAnswers: snapScale.normalizeDraftAnswers,
    setAnswer: snapScale.setAnswer,
    getQuestionState: snapScale.getQuestionState,
    buildScalePayload: snapScale.buildScalePayload
  }
}

const RISK_LABELS = {
  low: '低风险',
  medium: '中等风险',
  high: '高风险'
}

function isCompleteResult(result) {
  return Boolean(
    result &&
    Number.isFinite(result.total_score) &&
    typeof result.risk_level === 'string' &&
    typeof result.summary === 'string' &&
    Array.isArray(result.recommendations)
  )
}

registerPatientPage({
  data: {
    patientName: '患者',
    patientSupported: false,
    unsupportedMessage: '',
    title: asrsScale.ASRS_CONFIG.title,
    instructions: '请根据近 6 个月的实际情况作答',
    scaleKicker: '行为量表 · 成人版',
    estimatedMinutes: asrsScale.ASRS_CONFIG.estimatedMinutes,
    options: asrsScale.ASRS_CONFIG.options,
    answers: [],
    currentIndex: 0,
    questionNumber: 1,
    totalQuestions: asrsScale.ASRS_CONFIG.questions.length,
    currentQuestion: asrsScale.ASRS_CONFIG.questions[0],
    selectedValue: null,
    progressPercent: 6,
    isFirstQuestion: true,
    isLastQuestion: false,
    submitting: false,
    showResult: false,
    result: null,
    resultRiskLabel: ''
  },

  onLoad() {
    const user = wx.getStorageSync('current_user') || {}
    const patientProfile = user.patient_profile || {}
    const patientType = String(
      patientProfile.patient_type || ''
    ).toLowerCase()

    if (user.full_name) {
      this.setData({
        patientName: user.full_name
      })
    }

    const scaleModel = SCALE_MODELS[patientType]

    if (!scaleModel) {
      this.setData({
        patientSupported: false,
        unsupportedMessage:
          '暂时无法识别患者量表类型，请返回首页后重试。'
      })
      return
    }

    this.scaleModel = scaleModel
    this.draftKey = scaleModel.draftKey

    const answers = scaleModel.normalizeDraftAnswers(
      wx.getStorageSync(scaleModel.draftKey)
    )
    const currentIndex = answers.length >= scaleModel.config.questions.length
      ? scaleModel.config.questions.length - 1
      : answers.length

    this.setData({
      patientSupported: true,
      unsupportedMessage: '',
      title: scaleModel.config.title,
      instructions: scaleModel.instructions,
      scaleKicker: scaleModel.scaleKicker,
      estimatedMinutes: scaleModel.config.estimatedMinutes,
      options: scaleModel.config.options,
      answers,
      ...scaleModel.getQuestionState(currentIndex, answers)
    })
  },

  selectOption(event) {
    const value = Number(event.currentTarget.dataset.value)
    if (!this.scaleModel) {
      return
    }

    const answers = this.scaleModel.setAnswer(
      this.data.answers,
      this.data.currentIndex,
      value
    )

    if (answers[this.data.currentIndex] !== value) {
      return
    }

    wx.setStorageSync(this.draftKey, answers)
    this.setData({
      answers,
      ...this.scaleModel.getQuestionState(
        this.data.currentIndex,
        answers
      )
    })
  },

  goPrevious() {
    if (this.data.isFirstQuestion || this.data.submitting) {
      return
    }

    this.setData({
      ...this.scaleModel.getQuestionState(
        this.data.currentIndex - 1,
        this.data.answers
      )
    })
  },

  goNext() {
    if (this.data.submitting) {
      return
    }

    if (this.data.selectedValue === null) {
      wx.showToast({
        title: '请先选择本题答案',
        icon: 'none'
      })
      return
    }

    if (this.data.isLastQuestion) {
      return this.submitScale()
    }

    this.setData({
      ...this.scaleModel.getQuestionState(
        this.data.currentIndex + 1,
        this.data.answers
      )
    })
  },

  async submitScale() {
    if (this.data.submitting) {
      return
    }

    if (!this.scaleModel) {
      return
    }

    const payload = this.scaleModel.buildScalePayload(
      this.data.answers
    )

    if (!payload) {
      const firstMissingIndex = this.scaleModel.config.questions.findIndex(
        (_, index) => !Number.isInteger(this.data.answers[index])
      )
      this.setData({
        ...this.scaleModel.getQuestionState(
          firstMissingIndex >= 0 ? firstMissingIndex : 0,
          this.data.answers
        )
      })
      const totalQuestions = Number.isInteger(this.data.totalQuestions)
        ? this.data.totalQuestions
        : this.scaleModel.config.questions.length
      wx.showToast({
        title: `请完成全部${totalQuestions}道题目`,
        icon: 'none'
      })
      return
    }

    this.setData({
      submitting: true
    })
    const lease = capturePatientSessionLease()

    try {
      const result = await request({
        url: '/patient/submit_scale',
        method: 'POST',
        data: payload
      })
      if (!isPatientSessionLeaseCurrent(lease)) return

      if (!isCompleteResult(result)) {
        throw new Error('INCOMPLETE_SCALE_RESULT')
      }

      if (isReportableScaleResult(result)) {
        wx.setStorageSync(SCALE_LATEST_RESULT_KEY, result)
      }

      wx.removeStorageSync(this.draftKey)
      this.setData({
        result,
        resultRiskLabel:
          RISK_LABELS[result.risk_level] || result.risk_level,
        showResult: true,
        submitting: false
      })
    } catch (error) {
      if (!isPatientSessionLeaseCurrent(lease)) return
      this.setData({
        submitting: false
      })
      wx.showToast({
        title: '量表提交失败，答案已保留',
        icon: 'none',
        duration: 2500
      })
    }
  },

  goBack() {
    wx.navigateBack({
      delta: 1
    })
  }
})

module.exports = {
  isCompleteResult
}
