const { registerPatientPage } = require('../../utils/patient-page')
const { getTaskConfig } = require('../../utils/cognitive-config')
const { withTaskInstructions } = require('../../utils/cognitive-instructions')
const { buildNBackTrials, evaluateNBackAnswer, summarizeNBackTrials, buildNBackPayload } = require('../../utils/nback-test')
const { loadCognitiveContext, finishPage, retryPageSync, goNextBatteryTask, clearTimers, schedule } = require('../../utils/cognitive-page-support')

const PENDING_KEY = 'pending_nback_result'

registerPatientPage(withTaskInstructions('nback', {
  data: { patientName: '患者', ageGroup: 'child', mode: 'single', phase: 'intro', running: false, submitting: false, grid: Array.from({ length: 9 }, (_, index) => ({ index, active: false })), currentTrial: 0, totalTrials: 0, scoredTrials: 22, progressPercent: 0, result: null, syncStatus: '', hasPendingResult: false, nextTaskId: '' },
  onLoad(query) {
    this._context = loadCognitiveContext(query)
    this._config = getTaskConfig('nback', this._context.ageGroup)
    this.setData({ ...this._context, totalTrials: this._config.formalTrials, scoredTrials: this._config.formalTrials - 2, hasPendingResult: Boolean(wx.getStorageSync(PENDING_KEY)) })
  },
  startTest() {
    if (this.data.running || this.data.submitting) return
    clearTimers(this)
    this._trials = buildNBackTrials(this._config.formalTrials)
    this._records = []
    this._index = 0
    this.setData({ running: true, progressPercent: 0, result: null, syncStatus: '' })
    this._showTrial()
  },
  _showTrial() {
    const trial = this._trials[this._index]
    if (!trial || !this.data.running) return
    this._trialHandled = false
    this._trialAt = Date.now()
    this.setData({ phase: trial.scored ? 'testing' : 'memory', currentTrial: this._index + 1, grid: this.data.grid.map((cell) => ({ ...cell, active: cell.index === trial.position })) })
  },
  handleCellTap(event) {
    if (!this.data.running || this.data.phase !== 'memory' || this._trialHandled) return
    const trial = this._trials[this._index]
    const dataset = event.currentTarget.dataset
    if (Number(dataset.index) !== trial.position || (dataset.trial !== undefined && Number(dataset.trial) !== trial.id)) return
    this._advanceTrial()
  },
  handleAnswer(event) {
    if (!this.data.running || this.data.phase !== 'testing' || this._trialHandled) return
    const dataset = event.currentTarget.dataset
    const trial = this._trials[this._index]
    if (dataset.trial !== undefined && Number(dataset.trial) !== trial.id) return
    if (![true, false, 'true', 'false'].includes(dataset.match)) return
    this._recordAnswer(dataset.match === true || dataset.match === 'true', Date.now() - this._trialAt)
  },
  _recordAnswer(match, elapsed) {
    if (!this.data.running || this.data.phase !== 'testing' || this._trialHandled || (match !== true && match !== false)) return
    this._records.push(evaluateNBackAnswer(this._trials[this._index], match, elapsed))
    this._advanceTrial()
  },
  _advanceTrial() {
    if (this._trialHandled) return
    this._trialHandled = true
    clearTimers(this)
    this._index += 1
    this.setData({ phase: 'interval', grid: this.data.grid.map((cell) => ({ ...cell, active: false })), progressPercent: Math.round((this._index / this._trials.length) * 100) })
    if (this._index >= this._trials.length) return this._completeTest()
    schedule(this, () => this._showTrial(), 400)
  },
  _completeTest() { clearTimers(this); const summary = summarizeNBackTrials(this._records); return finishPage(this, 'nback', buildNBackPayload(summary, this._records, this._context), PENDING_KEY, this._trials.length) },
  retrySync() { return retryPageSync(this, PENDING_KEY) }, goNext() { goNextBatteryTask(this) }, goBack() { wx.navigateBack({ delta: 1 }) },
  onHide() {
    if (this.data.running) {
      clearTimers(this)
      this._context.interruptedCount = (Number(this._context.interruptedCount) || 0) + 1
      this.setData({ running: false, phase: 'paused' })
    }
  },
  onUnload() { clearTimers(this) }
}))
