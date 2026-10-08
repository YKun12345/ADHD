const { registerPatientPage } = require('../../utils/patient-page')
const { getTaskConfig } = require('../../utils/cognitive-config')
const { withTaskInstructions } = require('../../utils/cognitive-instructions')
const { buildFlankerTrials, evaluateFlankerTrial, summarizeFlankerTrials, buildFlankerPayload } = require('../../utils/flanker-test')
const { loadCognitiveContext, finishPage, retryPageSync, goNextBatteryTask, clearTimers, schedule } = require('../../utils/cognitive-page-support')

const PENDING_KEY = 'pending_flanker_result'

function stimulus(trial) {
  const target = trial.target === 'left' ? '←' : '→'
  if (trial.condition === 'neutral') return `◇ ◇ ${target} ◇ ◇`
  const flank = trial.condition === 'congruent' ? target : (trial.target === 'left' ? '→' : '←')
  return `${flank} ${flank} ${target} ${flank} ${flank}`
}

registerPatientPage(withTaskInstructions('flanker', {
  data: { patientName: '患者', ageGroup: 'child', mode: 'single', phase: 'intro', running: false, submitting: false, currentTrial: 0, totalTrials: 0, progressPercent: 0, stimulusText: '', result: null, syncStatus: '', hasPendingResult: false, nextTaskId: '' },
  onLoad(query) { this._context = loadCognitiveContext(query); this._config = getTaskConfig('flanker', this._context.ageGroup); this.setData({ ...this._context, totalTrials: this._config.formalTrials, hasPendingResult: Boolean(wx.getStorageSync(PENDING_KEY)) }) },
  startTest() { if (this.data.running || this.data.submitting) return; clearTimers(this); this._trials = buildFlankerTrials(this._config.formalTrials); this._records = []; this._index = 0; this.setData({ phase: 'testing', running: true, currentTrial: 1, progressPercent: 0, result: null, syncStatus: '' }); this._showTrial() },
  _showTrial() { const trial = this._trials[this._index]; if (!trial || !this.data.running) return; this._trialHandled = false; this._trialAt = Date.now(); this.setData({ phase: 'testing', stimulusText: stimulus(trial), currentTrial: this._index + 1 }); schedule(this, () => { if (this.data.phase === 'testing') this._recordAnswer('', null) }, this._config.responseWindowMs) },
  handleAnswer(event) { if (!this.data.running || this.data.phase !== 'testing') return; const dataset = event.currentTarget.dataset; if (dataset.trial !== undefined && Number(dataset.trial) !== this._trials[this._index].id) return; if (!['left', 'right'].includes(dataset.direction)) return; this._recordAnswer(dataset.direction, Date.now() - this._trialAt) },
  _recordAnswer(answer, elapsed) { if (!this.data.running || this.data.phase !== 'testing' || this._trialHandled) return; this._trialHandled = true; clearTimers(this); this._records.push(evaluateFlankerTrial(this._trials[this._index], answer, elapsed)); this._index += 1; this.setData({ phase: 'feedback', progressPercent: Math.round((this._index / this._trials.length) * 100) }); if (this._index >= this._trials.length) return this._completeTest(); schedule(this, () => this._showTrial(), 250) },
  _completeTest() { clearTimers(this); const summary = summarizeFlankerTrials(this._records); return finishPage(this, 'flanker', buildFlankerPayload(summary, this._records, this._context), PENDING_KEY) },
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
