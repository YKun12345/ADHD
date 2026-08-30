const { registerPatientPage } = require('../../utils/patient-page')
const { getTaskConfig } = require('../../utils/cognitive-config')
const { buildNBackTrials, evaluateNBackAnswer, summarizeNBackTrials, buildNBackPayload } = require('../../utils/nback-test')
const { loadCognitiveContext, finishPage, retryPageSync, goNextBatteryTask, clearTimers, schedule } = require('../../utils/cognitive-page-support')

const PENDING_KEY = 'pending_nback_result'

registerPatientPage({
  data: { patientName: '患者', ageGroup: 'child', mode: 'single', phase: 'intro', running: false, submitting: false, grid: Array.from({ length: 9 }, (_, index) => ({ index, active: false })), currentTrial: 0, totalTrials: 0, progressPercent: 0, result: null, syncStatus: '', hasPendingResult: false, nextTaskId: '' },
  onLoad(query) { this._context = loadCognitiveContext(query); this._config = getTaskConfig('nback', this._context.ageGroup); this.setData({ ...this._context, totalTrials: this._config.formalTrials, hasPendingResult: Boolean(wx.getStorageSync(PENDING_KEY)) }) },
  startTest() { if (this.data.running || this.data.submitting) return; clearTimers(this); this._trials = buildNBackTrials(this._config.formalTrials); this._records = []; this._index = 0; this.setData({ phase: 'testing', running: true, progressPercent: 0, result: null, syncStatus: '' }); this._showTrial() },
  _showTrial() { const trial = this._trials[this._index]; this._trialAt = Date.now(); this.setData({ phase: 'testing', currentTrial: this._index + 1, grid: this.data.grid.map((cell) => ({ ...cell, active: cell.index === trial.position })) }); schedule(this, () => { if (this.data.phase === 'testing') this._recordAnswer(null, null) }, this._config.responseWindowMs) },
  handleAnswer(event) { if (!this.data.running || this.data.phase !== 'testing') return; this._recordAnswer(event.currentTarget.dataset.match === true || event.currentTarget.dataset.match === 'true', Date.now() - this._trialAt) },
  _recordAnswer(match, elapsed) { clearTimers(this); const trial = this._trials[this._index]; const record = evaluateNBackAnswer(trial, match, elapsed); if (trial.scored) this._records.push(record); this._index += 1; this.setData({ phase: 'interval', grid: this.data.grid.map((cell) => ({ ...cell, active: false })), progressPercent: Math.round((this._index / this._trials.length) * 100) }); if (this._index >= this._trials.length) return this._completeTest(); schedule(this, () => this._showTrial(), 400) },
  _completeTest() { clearTimers(this); const summary = summarizeNBackTrials(this._records); return finishPage(this, 'nback', buildNBackPayload(summary, this._records, this._context), PENDING_KEY) },
  retrySync() { return retryPageSync(this, PENDING_KEY) }, goNext() { goNextBatteryTask(this) }, goBack() { wx.navigateBack({ delta: 1 }) },
  onHide() {
    if (this.data.running) {
      clearTimers(this)
      this._context.interruptedCount = (Number(this._context.interruptedCount) || 0) + 1
      this.setData({ running: false, phase: 'paused' })
    }
  },
  onUnload() { clearTimers(this) }
})
