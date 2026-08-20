const { request } = require('../../utils/request')
const {
  ASRS_DRAFT_KEY,
  ASRS_CONFIG,
  normalizeDraftAnswers,
  setAnswer,
  getQuestionState,
  buildScalePayload
} = require('../../utils/asrs-scale')

function isCompleteResult(result) {
  return Boolean(
    result &&
    Number.isFinite(result.total_score) &&
    typeof result.risk_level === 'string' &&
    typeof result.summary === 'string' &&
    Array.isArray(result.recommendations)
  )
}

Page({
  data: {
    patientName: '患者',
    patientSupported: false,
    unsupportedMessage: '',
    title: ASRS_CONFIG.title,
    estimatedMinutes: ASRS_CONFIG.estimatedMinutes,
    options: ASRS_CONFIG.options,
    answers: [],
    currentIndex: 0,
    questionNumber: 1,
    totalQuestions: ASRS_CONFIG.questions.length,
    currentQuestion: ASRS_CONFIG.questions[0],
    selectedValue: null,
    progressPercent: 6,
    isFirstQuestion: true,
    isLastQuestion: false,
    submitting: false,
    showResult: false,
    result: null
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

    if (patientType !== 'adult') {
      this.setData({
        patientSupported: false,
        unsupportedMessage:
          '儿童患者请使用 SNAP-IV 儿童量表，该量表将在 D5 开放。'
      })
      return
    }

    const answers = normalizeDraftAnswers(
      wx.getStorageSync(ASRS_DRAFT_KEY)
    )
    const currentIndex = answers.length >= ASRS_CONFIG.questions.length
      ? ASRS_CONFIG.questions.length - 1
      : answers.length

    this.setData({
      patientSupported: true,
      unsupportedMessage: '',
      answers,
      ...getQuestionState(currentIndex, answers)
    })
  },

  selectOption(event) {
    const value = Number(event.currentTarget.dataset.value)
    const answers = setAnswer(
      this.data.answers,
      this.data.currentIndex,
      value
    )

    if (answers[this.data.currentIndex] !== value) {
      return
    }

    wx.setStorageSync(ASRS_DRAFT_KEY, answers)
    this.setData({
      answers,
      ...getQuestionState(this.data.currentIndex, answers)
    })
  },

  goPrevious() {
    if (this.data.isFirstQuestion || this.data.submitting) {
      return
    }

    this.setData({
      ...getQuestionState(
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
      ...getQuestionState(
        this.data.currentIndex + 1,
        this.data.answers
      )
    })
  },

  async submitScale() {
    if (this.data.submitting) {
      return
    }

    const payload = buildScalePayload(this.data.answers)

    if (!payload) {
      const firstMissingIndex = ASRS_CONFIG.questions.findIndex(
        (_, index) => !Number.isInteger(this.data.answers[index])
      )
      this.setData({
        ...getQuestionState(
          firstMissingIndex >= 0 ? firstMissingIndex : 0,
          this.data.answers
        )
      })
      wx.showToast({
        title: '请完成全部18道题目',
        icon: 'none'
      })
      return
    }

    this.setData({
      submitting: true
    })

    try {
      const result = await request({
        url: '/patient/submit_scale',
        method: 'POST',
        data: payload
      })

      if (!isCompleteResult(result)) {
        throw new Error('INCOMPLETE_SCALE_RESULT')
      }

      wx.removeStorageSync(ASRS_DRAFT_KEY)
      this.setData({
        result,
        showResult: true,
        submitting: false
      })
    } catch (error) {
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
