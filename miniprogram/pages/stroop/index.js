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
const { withTaskInstructions } = require('../../utils/cognitive-instructions')
const { loadCognitiveContext, finishPage, retryPageSync, syncPayload, goNextBatteryTask } = require('../../utils/cognitive-page-support')

const PENDING_STROOP_KEY = 'pending_stroop_result'
const FEEDBACK_DURATION_MS = 350

function getColor(key) {
  return COLORS.find((color) => color.key === key) || COLORS[0]
}

registerPatientPage(withTaskInstructions('stroop', {
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
    this._context = loadCognitiveContext(query)
    this._config = getTaskConfig('stroop', this._context.ageGroup)
    this._useFullProtocol = true
    this._trials = buildStroopTrials(this._config.formalTrials, this._config.congruentRatio)
    this.setData({
      ...this._context,
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
    const generation = this._runGeneration
      this._responseTimer = setTimeout(() => {
        this._responseTimer = null
        if (this._disposed || this._hidden || generation !== this._runGeneration || !isPatientSessionLeaseCurrent(lease) || this.data.phase !== 'testing') return
        this._recordTrial(evaluateStroopChoice(trial, null, null), trial)
      }, this._config.responseWindowMs)
    }
  },

  handleAnswer(event) {
    if (!this.data.running || this.data.phase !== 'testing') {
      return
    }

    const dataset = event.currentTarget.dataset
    if (dataset.trial !== undefined && Number(dataset.trial) !== this.data.currentTrialNumber) return
    const selectedKey = dataset.key
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
    const generation = this._runGeneration
    this._feedbackTimer = setTimeout(() => {
      this._feedbackTimer = null
      if (this._disposed || this._hidden || generation !== this._runGeneration || !isPatientSessionLeaseCurrent(lease)) return
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
    if (this._completionSaved || !Array.isArray(this._records) || this._records.length !== this._config.formalTrials) return
    this._clearFeedbackTimer()
    this._finishedAt = this._finishedAt || new Date().toISOString()
    const payload = buildStroopPayload(this._records, this._finishedAt, this._context)
    this.setData({ progressPercent: 100 })
    return finishPage(this, 'stroop', payload, PENDING_STROOP_KEY, this._records.length)
  },

  _syncResult(payload) { return syncPayload(this, payload, PENDING_STROOP_KEY) },
  retrySync() { return retryPageSync(this, PENDING_STROOP_KEY) },
  restartTest() { return this.startTest() },

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
}))

module.exports = {
  PENDING_STROOP_KEY,
  FEEDBACK_DURATION_MS,
  getColor
}
