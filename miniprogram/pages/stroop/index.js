const { request } = require('../../utils/request')
const {
  COLORS,
  STROOP_TRIALS,
  evaluateStroopChoice,
  summarizeStroopTrials,
  buildStroopPayload
} = require('../../utils/stroop-test')
const {
  LATEST_RESULTS_KEY,
  mergeLatestResult
} = require('../../utils/cognitive-results')

const PENDING_STROOP_KEY = 'pending_stroop_result'
const FEEDBACK_DURATION_MS = 350

function getColor(key) {
  return COLORS.find((color) => color.key === key) || COLORS[0]
}

Page({
  data: {
    patientName: '患者',
    phase: 'intro',
    running: false,
    submitting: false,
    colors: COLORS,
    currentTrialIndex: 0,
    currentTrialNumber: 1,
    totalTrials: STROOP_TRIALS.length,
    progressPercent: 0,
    currentWord: '',
    currentColorHex: '#17324d',
    feedbackText: '',
    feedbackCorrect: false,
    result: null,
    syncStatus: '',
    hasPendingResult: false
  },

  onLoad() {
    const user = wx.getStorageSync('current_user') || {}
    this.setData({
      patientName: user.full_name || '患者',
      hasPendingResult: Boolean(wx.getStorageSync(PENDING_STROOP_KEY))
    })
  },

  startTest() {
    if (this.data.running || this.data.submitting) {
      return
    }

    this._clearFeedbackTimer()
    this._records = []
    this._finishedAt = ''
    this.setData({
      phase: 'testing',
      running: true,
      currentTrialIndex: 0,
      currentTrialNumber: 1,
      progressPercent: 0,
      feedbackText: '',
      feedbackCorrect: false,
      result: null,
      syncStatus: ''
    })
    this._showTrial()
  },

  _showTrial() {
    const trial = STROOP_TRIALS[this.data.currentTrialIndex]
    if (!trial || !this.data.running) {
      return
    }

    const word = getColor(trial.wordKey)
    const ink = getColor(trial.colorKey)
    this._trialStartedAt = Date.now()
    this.setData({
      phase: 'testing',
      currentWord: word.label,
      currentColorHex: ink.hex,
      feedbackText: '',
      feedbackCorrect: false
    })
  },

  handleAnswer(event) {
    if (!this.data.running || this.data.phase !== 'testing') {
      return
    }

    const selectedKey = event.currentTarget.dataset.key
    const trial = STROOP_TRIALS[this.data.currentTrialIndex]
    const record = evaluateStroopChoice(
      trial,
      selectedKey,
      Date.now() - this._trialStartedAt
    )

    if (!record) {
      return
    }

    this._records = Array.isArray(this._records)
      ? [...this._records, record]
      : [record]
    const completed = this._records.length
    this.setData({
      phase: 'feedback',
      feedbackCorrect: record.correct,
      feedbackText: record.correct
        ? '回答正确'
        : `正确颜色是${getColor(trial.colorKey).label}色`,
      progressPercent: Math.round(
        (completed / STROOP_TRIALS.length) * 100
      )
    })

    this._feedbackTimer = setTimeout(() => {
      this._feedbackTimer = null
      if (completed >= STROOP_TRIALS.length) {
        this._completeTest()
        return
      }

      const nextIndex = this.data.currentTrialIndex + 1
      this.setData({
        currentTrialIndex: nextIndex,
        currentTrialNumber: nextIndex + 1
      })
      this._showTrial()
    }, FEEDBACK_DURATION_MS)
  },

  async _completeTest() {
    const result = summarizeStroopTrials(this._records)
    if (result.total_trials !== STROOP_TRIALS.length) {
      return
    }

    this._clearFeedbackTimer()
    this._finishedAt = this._finishedAt || new Date().toISOString()
    const payload = buildStroopPayload(this._records, this._finishedAt)
    const latestResults = mergeLatestResult(
      wx.getStorageSync(LATEST_RESULTS_KEY),
      payload
    )
    wx.setStorageSync(LATEST_RESULTS_KEY, latestResults)

    this.setData({
      phase: 'result',
      running: false,
      progressPercent: 100,
      result,
      syncStatus: '同步中'
    })

    return this._syncResult(payload)
  },

  async _syncResult(payload) {
    if (this.data.submitting || !payload) {
      return
    }

    this.setData({
      submitting: true,
      syncStatus: '同步中'
    })

    try {
      await request({
        url: '/patient/submit_cognitive_test',
        method: 'POST',
        data: payload
      })
      wx.removeStorageSync(PENDING_STROOP_KEY)
      this.setData({
        submitting: false,
        syncStatus: '已同步',
        hasPendingResult: false
      })
    } catch (error) {
      wx.setStorageSync(PENDING_STROOP_KEY, payload)
      this.setData({
        submitting: false,
        syncStatus: '待同步',
        hasPendingResult: true
      })
    }
  },

  retrySync() {
    if (this.data.submitting) {
      return
    }

    const pendingPayload = wx.getStorageSync(PENDING_STROOP_KEY)
    const localPayload = buildStroopPayload(
      this._records,
      this._finishedAt
    )
    return this._syncResult(pendingPayload || localPayload)
  },

  restartTest() {
    if (!this.data.submitting) {
      this.startTest()
    }
  },

  _clearFeedbackTimer() {
    if (this._feedbackTimer) {
      clearTimeout(this._feedbackTimer)
      this._feedbackTimer = null
    }
  },

  onUnload() {
    this._clearFeedbackTimer()
    this.setData({
      running: false
    })
  },

  goBack() {
    this._clearFeedbackTimer()
    wx.navigateBack({
      delta: 1
    })
  }
})

module.exports = {
  PENDING_STROOP_KEY,
  FEEDBACK_DURATION_MS,
  getColor
}
