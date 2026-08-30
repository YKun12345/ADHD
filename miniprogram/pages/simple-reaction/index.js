const { registerPatientPage } = require('../../utils/patient-page')
const { getTaskConfig } = require('../../utils/cognitive-config')
const { buildDelaySequence, evaluateReactionTrial, summarizeReactionTrials, buildSimpleReactionPayload } = require('../../utils/simple-reaction-test')
const { loadCognitiveContext, finishPage, retryPageSync, goNextBatteryTask, clearTimers, schedule } = require('../../utils/cognitive-page-support')

const PENDING_KEY = 'pending_simple_reaction_result'

registerPatientPage({
  data: { patientName: '患者', ageGroup: 'child', mode: 'single', phase: 'intro', phaseText: '', running: false, submitting: false, progressPercent: 0, currentTrial: 0, totalTrials: 0, result: null, syncStatus: '', hasPendingResult: false, nextTaskId: '' },
  onLoad(query) {
    this._context = loadCognitiveContext(query)
    this._config = getTaskConfig('simple_reaction', this._context.ageGroup)
    this.setData({ ...this._context, totalTrials: this._config.formalTrials, hasPendingResult: Boolean(wx.getStorageSync(PENDING_KEY)) })
  },
  startTest() {
    if (this.data.running || this.data.submitting) return
    clearTimers(this)
    this._records = []
    this._delays = buildDelaySequence(this._config.formalTrials, this._config.minDelayMs, this._config.maxDelayMs)
    this._trialIndex = 0
    this.setData({ phase: 'waiting', phaseText: '等待目标出现', running: true, progressPercent: 0, currentTrial: 1, result: null, syncStatus: '' })
    this._beginTrial()
  },
  _beginTrial() {
    if (!this.data.running) return
    this.setData({ phase: 'waiting', phaseText: '等待目标出现，请不要提前点击', currentTrial: this._trialIndex + 1 })
    schedule(this, () => {
      this._targetAt = Date.now()
      this.setData({ phase: 'target', phaseText: '立即点击' })
      schedule(this, () => {
        if (this.data.phase !== 'target') return
        this._records.push(evaluateReactionTrial({ responseTimeMs: null }))
        this._advanceTrial()
      }, this._config.responseWindowMs)
    }, this._delays[this._trialIndex])
  },
  handleTargetTap() {
    if (!this.data.running) return
    if (this.data.phase === 'waiting') {
      clearTimers(this)
      this._records.push(evaluateReactionTrial({ clickedEarly: true }))
      this._advanceTrial()
      return
    }
    if (this.data.phase !== 'target') return
    clearTimers(this)
    this._records.push(evaluateReactionTrial({ responseTimeMs: Date.now() - this._targetAt }))
    this._advanceTrial()
  },
  _advanceTrial() {
    this._trialIndex += 1
    this.setData({ progressPercent: Math.round((this._trialIndex / this._config.formalTrials) * 100) })
    if (this._trialIndex >= this._config.formalTrials) return this._completeTest()
    schedule(this, () => this._beginTrial(), 350)
  },
  _completeTest() {
    clearTimers(this)
    const summary = summarizeReactionTrials(this._records)
    const payload = buildSimpleReactionPayload(summary, this._records, this._context)
    return finishPage(this, 'simple_reaction', payload, PENDING_KEY)
  },
  retrySync() { return retryPageSync(this, PENDING_KEY) },
  goNext() { goNextBatteryTask(this) },
  goBack() { wx.navigateBack({ delta: 1 }) },
  onHide() {
    if (this.data.running) {
      clearTimers(this)
      this._context.interruptedCount = (Number(this._context.interruptedCount) || 0) + 1
      this.setData({ running: false, phase: 'paused', phaseText: '测试已中断，请重新开始本项' })
    }
  },
  onUnload() { clearTimers(this) }
})
