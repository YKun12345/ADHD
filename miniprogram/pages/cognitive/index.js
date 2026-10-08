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
  TRIAL_SEQUENCE,
  buildGoNoGoTrials,
  evaluateTrial,
  summarizeTrials,
  buildCognitivePayload
} = require('../../utils/gonogo-test')
const {
  LATEST_RESULTS_KEY,
  mergeLatestResult
} = require('../../utils/cognitive-results')
const { getTaskConfig } = require('../../utils/cognitive-config')
const { withTaskInstructions } = require('../../utils/cognitive-instructions')
const { loadCognitiveContext, finishPage, retryPageSync, syncPayload, goNextBatteryTask } = require('../../utils/cognitive-page-support')

const PENDING_RESULT_KEY = 'pending_cognitive_result'
const WAITING_DELAYS = [800, 1000, 1200, 1400]
const RESPONSE_WINDOW_MS = 800
const FEEDBACK_DURATION_MS = 450

function feedbackFor(record) {
  if (record.correct && record.type === 'go') {
    return `反应正确 · ${record.reactionTimeMs} 毫秒`
  }

  if (record.correct) {
    return '抑制正确'
  }

  const messages = {
    commission: '本轮应保持不点击',
    omission: '本轮需要点击',
    false_start: '请等待页面变色'
  }

  return messages[record.errorType] || '请集中注意力'
}

registerPatientPage(withTaskInstructions('reaction', {
  data: {
    patientName: '患者',
    ageGroup: 'child',
    mode: 'single',
    nextTaskId: '',
    phase: 'intro',
    running: false,
    submitting: false,
    currentTrialIndex: 0,
    currentTrialNumber: 1,
    totalTrials: TRIAL_SEQUENCE.length,
    progressPercent: 0,
    stimulusType: '',
    stimulusLabel: '',
    feedbackText: '',
    feedbackCorrect: false,
    result: null,
    syncStatus: '',
    hasPendingResult: false
  },

  onLoad(query) {
    this._context = loadCognitiveContext(query)
    this._config = getTaskConfig('reaction', this._context.ageGroup)
    this._useFullProtocol = true
    this._trials = buildGoNoGoTrials(this._config.formalTrials)
    this.setData({
      ...this._context,
      totalTrials: this._trials.length,
      hasPendingResult: Boolean(wx.getStorageSync(PENDING_RESULT_KEY))
    })
  },

  startTest() {
    if (this.data.running || this.data.submitting) {
      return
    }

    this._clearTimers()
    this._trials = Array.isArray(this._trials) && this._trials.length
      ? this._trials
      : TRIAL_SEQUENCE.slice()
    this._context = this._context || { ageGroup: 'child', mode: 'single' }
    this._records = []
    this._finishedAt = ''
    this.setData({
      phase: 'waiting',
      running: true,
      currentTrialIndex: 0,
      currentTrialNumber: 1,
      progressPercent: 0,
      stimulusType: '',
      stimulusLabel: '',
      feedbackText: '保持专注，等待页面变色',
      feedbackCorrect: false,
      result: null,
      syncStatus: ''
    })
    this._scheduleTrial()
  },

  _scheduleTrial() {
    this._clearTimers()
    const index = this.data.currentTrialIndex
    const delay = WAITING_DELAYS[index % WAITING_DELAYS.length]
    this._trialHandled = false

    this.setData({
      phase: 'waiting',
      stimulusType: '',
      stimulusLabel: '',
      feedbackText: '保持专注，等待页面变色',
      feedbackCorrect: false
    })

    const lease = capturePatientSessionLease()
    const generation = this._runGeneration
    this._stimulusTimer = setTimeout(() => {
      this._stimulusTimer = null
      if (this._disposed || this._hidden || generation !== this._runGeneration || !isPatientSessionLeaseCurrent(lease)) return
      this._showStimulus()
    }, delay)
  },

  _showStimulus() {
    this._trials = Array.isArray(this._trials) && this._trials.length
      ? this._trials
      : TRIAL_SEQUENCE.slice()
    const type = this._trials[this.data.currentTrialIndex]
    if (!type || !this.data.running) {
      return
    }

    this._trialStartedAt = Date.now()
    this.setData({
      phase: 'stimulus',
      stimulusType: type,
      stimulusLabel: type === 'go' ? '点击' : '停'
    })

    const lease = capturePatientSessionLease()
    const generation = this._runGeneration
    this._responseTimer = setTimeout(() => {
      this._responseTimer = null
      if (this._disposed || this._hidden || generation !== this._runGeneration || !isPatientSessionLeaseCurrent(lease)) return
      const record = evaluateTrial({
        type,
        action: 'timeout'
      })
      this._finishTrial(record)
    }, this._config.responseWindowMs)
  },

  handleTestTap(event) {
    const trialNumber = event && event.currentTarget && event.currentTarget.dataset.trial
    if (trialNumber !== undefined && Number(trialNumber) !== this.data.currentTrialNumber) return
    if (!this.data.running) {
      return
    }

    const type = this._trials[this.data.currentTrialIndex]

    if (this.data.phase === 'waiting') {
      if (this._stimulusTimer) {
        clearTimeout(this._stimulusTimer)
        this._stimulusTimer = null
      }
      this._finishTrial(evaluateTrial({
        type,
        action: 'false_start'
      }))
      return
    }

    if (this.data.phase !== 'stimulus') {
      return
    }

    if (this._responseTimer) {
      clearTimeout(this._responseTimer)
      this._responseTimer = null
    }

    this._finishTrial(evaluateTrial({
      type,
      action: 'tap',
      reactionTimeMs: Date.now() - this._trialStartedAt
    }))
  },

  _finishTrial(record) {
    if (!record || !this.data.running || this._trialHandled || !['waiting', 'stimulus'].includes(this.data.phase)) {
      return
    }

    this._trialHandled = true

    if (this._stimulusTimer) {
      clearTimeout(this._stimulusTimer)
      this._stimulusTimer = null
    }
    if (this._responseTimer) {
      clearTimeout(this._responseTimer)
      this._responseTimer = null
    }

    this._records = Array.isArray(this._records)
      ? [...this._records, record]
      : [record]
    const completed = this._records.length

    this.setData({
      phase: 'feedback',
      stimulusType: '',
      stimulusLabel: '',
      feedbackText: this._useFullProtocol ? '作答已记录' : feedbackFor(record),
      feedbackCorrect: this._useFullProtocol ? false : record.correct,
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
      this._scheduleTrial()
    }, FEEDBACK_DURATION_MS)
  },

  async _completeTest() {
    if (this._completionSaved || !Array.isArray(this._records) || this._records.length !== this._config.formalTrials) return
    this._clearTimers()
    this._finishedAt = this._finishedAt || new Date().toISOString()
    const payload = buildCognitivePayload(this._records, this._finishedAt, this._context)
    this.setData({ progressPercent: 100 })
    return finishPage(this, 'reaction', payload, PENDING_RESULT_KEY, this._records.length)
  },

  _syncResult(payload) { return syncPayload(this, payload, PENDING_RESULT_KEY) },
  retrySync() { return retryPageSync(this, PENDING_RESULT_KEY) },
  restartTest() { return this.startTest() },

  _clearTimers() {
    for (const key of [
      '_stimulusTimer',
      '_responseTimer',
      '_feedbackTimer'
    ]) {
      if (this[key]) {
        clearTimeout(this[key])
        this[key] = null
      }
    }
  },

  onPatientSessionEnded() {
    this._clearTimers()
    this._records = []
    this._finishedAt = ''
    this.setData({
      running: false,
      submitting: false
    })
  },


  onHide() {
    if (this.data.running) {
      this._clearTimers()
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
    this._clearTimers()
    this.setData({
      running: false
    })
  },

  goNext() {
    goNextBatteryTask(this)
  },

  goBack() {
    this._clearTimers()
    wx.navigateBack({
      delta: 1
    })
  }
}))

module.exports = {
  PENDING_RESULT_KEY,
  WAITING_DELAYS,
  RESPONSE_WINDOW_MS,
  FEEDBACK_DURATION_MS,
  feedbackFor
}
