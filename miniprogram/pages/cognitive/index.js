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
const { loadCognitiveContext, recordBatteryCompletion, goNextBatteryTask } = require('../../utils/cognitive-page-support')

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
    false_start: '请等待图形出现'
  }

  return messages[record.errorType] || '请集中注意力'
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
    const user = wx.getStorageSync('current_user') || {}
    const pendingResult = wx.getStorageSync(PENDING_RESULT_KEY)
    this._context = loadCognitiveContext(query)
    this._config = getTaskConfig('reaction', this._context.ageGroup)
    this._useFullProtocol = Boolean(user.patient_profile && user.patient_profile.patient_type)
    this._trials = this._useFullProtocol
      ? buildGoNoGoTrials(this._config.formalTrials)
      : TRIAL_SEQUENCE.slice()

    this.setData({
      patientName: user.full_name || '患者',
      ageGroup: this._context.ageGroup,
      mode: this._context.mode,
      totalTrials: this._trials.length,
      hasPendingResult: Boolean(pendingResult)
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
      feedbackText: '保持专注，等待图形出现',
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

    this.setData({
      phase: 'waiting',
      stimulusType: '',
      stimulusLabel: '',
      feedbackText: '保持专注，等待图形出现',
      feedbackCorrect: false
    })

    const lease = capturePatientSessionLease()
    this._stimulusTimer = setTimeout(() => {
      this._stimulusTimer = null
      if (!isPatientSessionLeaseCurrent(lease)) return
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
    this._responseTimer = setTimeout(() => {
      this._responseTimer = null
      if (!isPatientSessionLeaseCurrent(lease)) return
      const record = evaluateTrial({
        type,
        action: 'timeout'
      })
      this._finishTrial(record)
    }, RESPONSE_WINDOW_MS)
  },

  handleTestTap() {
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
    if (!record || !this.data.running) {
      return
    }

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
      feedbackText: feedbackFor(record),
      feedbackCorrect: record.correct,
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
      this._scheduleTrial()
    }, FEEDBACK_DURATION_MS)
  },

  async _completeTest() {
    this._trials = Array.isArray(this._trials) && this._trials.length
      ? this._trials
      : TRIAL_SEQUENCE.slice()
    const result = summarizeTrials(this._records)
    if (result.total_trials !== this._trials.length) {
      return
    }

    this._clearTimers()
    this._finishedAt = this._finishedAt || new Date().toISOString()
    const payload = buildCognitivePayload(
      this._records,
      this._finishedAt,
      this._useFullProtocol ? this._context : null
    )
    const latestResults = mergeLatestResult(
      wx.getStorageSync(LATEST_RESULTS_KEY),
      payload
    )
    wx.setStorageSync(LATEST_RESULTS_KEY, latestResults)
    const nextTaskId = recordBatteryCompletion(this._context, 'reaction')

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
      wx.removeStorageSync(PENDING_RESULT_KEY)
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
      wx.setStorageSync(PENDING_RESULT_KEY, payload)
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

    const pendingPayload = wx.getStorageSync(PENDING_RESULT_KEY)
    const localPayload = buildCognitivePayload(
      this._records,
      this._finishedAt,
      this._useFullProtocol ? this._context : null
    )
    return this._syncResult(pendingPayload || localPayload)
  },

  restartTest() {
    if (this.data.submitting) {
      return
    }
    this.startTest()
  },

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
})

module.exports = {
  PENDING_RESULT_KEY,
  WAITING_DELAYS,
  RESPONSE_WINDOW_MS,
  FEEDBACK_DURATION_MS,
  feedbackFor
}
