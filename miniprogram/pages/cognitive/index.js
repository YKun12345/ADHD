const { request } = require('../../utils/request')
const {
  TRIAL_SEQUENCE,
  evaluateTrial,
  summarizeTrials,
  buildCognitivePayload
} = require('../../utils/gonogo-test')

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

Page({
  data: {
    patientName: '患者',
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

  onLoad() {
    const user = wx.getStorageSync('current_user') || {}
    const pendingResult = wx.getStorageSync(PENDING_RESULT_KEY)

    this.setData({
      patientName: user.full_name || '患者',
      hasPendingResult: Boolean(pendingResult)
    })
  },

  startTest() {
    if (this.data.running || this.data.submitting) {
      return
    }

    this._clearTimers()
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

    this._stimulusTimer = setTimeout(() => {
      this._stimulusTimer = null
      this._showStimulus()
    }, delay)
  },

  _showStimulus() {
    const type = TRIAL_SEQUENCE[this.data.currentTrialIndex]
    if (!type || !this.data.running) {
      return
    }

    this._trialStartedAt = Date.now()
    this.setData({
      phase: 'stimulus',
      stimulusType: type,
      stimulusLabel: type === 'go' ? '点击' : '停'
    })

    this._responseTimer = setTimeout(() => {
      this._responseTimer = null
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

    const type = TRIAL_SEQUENCE[this.data.currentTrialIndex]

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
        (completed / TRIAL_SEQUENCE.length) * 100
      )
    })

    this._feedbackTimer = setTimeout(() => {
      this._feedbackTimer = null
      if (completed >= TRIAL_SEQUENCE.length) {
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
    const result = summarizeTrials(this._records)
    if (result.total_trials !== TRIAL_SEQUENCE.length) {
      return
    }

    this._clearTimers()
    this._finishedAt = this._finishedAt || new Date().toISOString()
    this.setData({
      phase: 'result',
      running: false,
      progressPercent: 100,
      result,
      syncStatus: '同步中'
    })

    return this._syncResult(
      buildCognitivePayload(this._records, this._finishedAt)
    )
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
      wx.removeStorageSync(PENDING_RESULT_KEY)
      this.setData({
        submitting: false,
        syncStatus: '已同步',
        hasPendingResult: false
      })
    } catch (error) {
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
      this._finishedAt
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

  onUnload() {
    this._clearTimers()
    this.setData({
      running: false
    })
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
