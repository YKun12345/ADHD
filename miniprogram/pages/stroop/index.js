const { registerPatientPage } = require('../../utils/patient-page')
const {
  request,
  isPatientSessionError
} = require('../../utils/request')
const {
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
} = require('../../utils/session-privacy')
const {
  COLORS,
  STROOP_TRIALS,
  buildStroopTrials,
  evaluateStroopChoice,
  summarizeStroopTrials,
  buildStroopPayload
} = require('../../utils/stroop-test')
const {
  LATEST_RESULTS_KEY,
  mergeLatestResult
} = require('../../utils/cognitive-results')
const { getTaskConfig } = require('../../utils/cognitive-config')
const { loadCognitiveContext, recordBatteryCompletion, goNextBatteryTask } = require('../../utils/cognitive-page-support')

const PENDING_STROOP_KEY = 'pending_stroop_result'
const FEEDBACK_DURATION_MS = 350

function getColor(key) {
  return COLORS.find((color) => color.key === key) || COLORS[0]
}

registerPatientPage({
  data: {
    patientName: '患者',
    ageGroup: 'child',
    mode: 'single',
    nextTaskId: '',
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

  onLoad(query) {
    const user = wx.getStorageSync('current_user') || {}
    this._context = loadCognitiveContext(query)
    this._config = getTaskConfig('stroop', this._context.ageGroup)
    this._useFullProtocol = Boolean(user.patient_profile && user.patient_profile.patient_type)
    this._trials = this._useFullProtocol
      ? buildStroopTrials(this._config.formalTrials, this._config.congruentRatio)
      : STROOP_TRIALS.slice()
    this.setData({
      patientName: user.full_name || '患者',
      ageGroup: this._context.ageGroup,
      mode: this._context.mode,
      totalTrials: this._trials.length,
      hasPendingResult: Boolean(wx.getStorageSync(PENDING_STROOP_KEY))
    })
  },

  startTest() {
    if (this.data.running || this.data.submitting) {
      return
    }

    this._clearFeedbackTimer()
    this._trials = Array.isArray(this._trials) && this._trials.length
      ? this._trials
      : STROOP_TRIALS.slice()
    this._context = this._context || { ageGroup: 'child', mode: 'single' }
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
    const trial = this._trials[this.data.currentTrialIndex]
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

    if (this._useFullProtocol) {
      const lease = capturePatientSessionLease()
      this._responseTimer = setTimeout(() => {
        this._responseTimer = null
        if (!isPatientSessionLeaseCurrent(lease) || this.data.phase !== 'testing') return
        this._recordTrial(evaluateStroopChoice(trial, null, null), trial)
      }, this._config.responseWindowMs)
    }
  },

  handleAnswer(event) {
    if (!this.data.running || this.data.phase !== 'testing') {
      return
    }

    const selectedKey = event.currentTarget.dataset.key
    const trial = this._trials[this.data.currentTrialIndex]
    const record = evaluateStroopChoice(
      trial,
      selectedKey,
      Date.now() - this._trialStartedAt
    )

    if (!record) {
      return
    }


    if (this._responseTimer) {
      clearTimeout(this._responseTimer)
      this._responseTimer = null
    }

    this._recordTrial(record, trial)
  },

  _recordTrial(record, trial) {
    if (!record || !this.data.running || this.data.phase !== 'testing') return

    this._records = Array.isArray(this._records)
      ? [...this._records, record]
      : [record]
    const completed = this._records.length
    this.setData({
      phase: 'feedback',
      feedbackCorrect: this._useFullProtocol ? false : record.correct,
      feedbackText: this._useFullProtocol
        ? '作答已记录'
        : (record.correct ? '回答正确' : `正确颜色是${getColor(trial.colorKey).label}色`),
      progressPercent: Math.round(
        (completed / this._trials.length) * 100
      )
    })

    const lease = capturePatientSessionLease()
    this._feedbackTimer = setTimeout(() => {
      this._feedbackTimer = null
      if (!isPatientSessionLeaseCurrent(lease)) return
      if (completed >= this._trials.length) {
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
    this._trials = Array.isArray(this._trials) && this._trials.length
      ? this._trials
      : STROOP_TRIALS.slice()
    const result = summarizeStroopTrials(this._records)
    if (result.total_trials !== this._trials.length) {
      return
    }

    this._clearFeedbackTimer()
    this._finishedAt = this._finishedAt || new Date().toISOString()
    const payload = buildStroopPayload(
      this._records,
      this._finishedAt,
      this._useFullProtocol ? this._context : null
    )
    const latestResults = mergeLatestResult(
      wx.getStorageSync(LATEST_RESULTS_KEY),
      payload
    )
    wx.setStorageSync(LATEST_RESULTS_KEY, latestResults)
    const nextTaskId = recordBatteryCompletion(this._context, 'stroop')

    this.setData({
      phase: 'result',
      running: false,
      progressPercent: 100,
      result,
      nextTaskId,
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

    const lease = capturePatientSessionLease()

    try {
      await request({
        url: '/patient/submit_cognitive_test',
        method: 'POST',
        data: payload
      })
      if (!isPatientSessionLeaseCurrent(lease)) return
      wx.removeStorageSync(PENDING_STROOP_KEY)
      this.setData({
        submitting: false,
        syncStatus: '已同步',
        hasPendingResult: false
      })
    } catch (error) {
      if (
        isPatientSessionError(error) ||
        !isPatientSessionLeaseCurrent(lease)
      ) {
        return
      }
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
      this._finishedAt,
      this._useFullProtocol ? this._context : null
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
    if (this._responseTimer) {
      clearTimeout(this._responseTimer)
      this._responseTimer = null
    }
  },

  onPatientSessionEnded() {
    this._clearFeedbackTimer()
    this._records = []
    this._finishedAt = ''
    this.setData({
      running: false,
      submitting: false
    })
  },

  onHide() {
    if (this.data.running) {
      this._clearFeedbackTimer()
      if (this._context) {
        this._context.interruptedCount =
          (Number(this._context.interruptedCount) || 0) + 1
      }
      this.setData({
        running: false,
        phase: 'intro'
      })
    }
  },

  onUnload() {
    this._clearFeedbackTimer()
    this.setData({
      running: false
    })
  },

  goNext() {
    goNextBatteryTask(this)
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
