const { registerPatientPage } = require('../../utils/patient-page')
const { getTaskConfig } = require('../../utils/cognitive-config')
const { buildDigitTrials, evaluateDigitTrial, summarizeDigitTrials, buildDigitSpanPayload } = require('../../utils/digit-span-test')
const { loadCognitiveContext, finishPage, retryPageSync, goNextBatteryTask, clearTimers, schedule } = require('../../utils/cognitive-page-support')

const PENDING_KEY = 'pending_digit_result'

registerPatientPage({
  data: { patientName: '患者', ageGroup: 'child', mode: 'single', phase: 'intro', running: false, submitting: false, directionText: '顺背', shownDigit: '', answer: [], answerText: '', currentTrial: 0, totalTrials: 0, progressPercent: 0, result: null, syncStatus: '', hasPendingResult: false, nextTaskId: '', keypad: [1, 2, 3, 4, 5, 6, 7, 8, 9, 0] },
  onLoad(query) { this._context = loadCognitiveContext(query); this._config = getTaskConfig('digit', this._context.ageGroup); const count = (this._config.maxSpan - this._config.minSpan + 1) * this._config.trialsPerSpan * 2; this.setData({ ...this._context, totalTrials: count, hasPendingResult: Boolean(wx.getStorageSync(PENDING_KEY)) }) },
  startTest() { if (this.data.running || this.data.submitting) return; clearTimers(this); this._trials = buildDigitTrials(this._config.minSpan, this._config.maxSpan, this._config.trialsPerSpan); this._records = []; this._index = 0; this.setData({ running: true, progressPercent: 0, result: null, syncStatus: '' }); this._presentTrial() },
  _presentTrial() { const trial = this._trials[this._index]; this._shownIndex = 0; this.setData({ phase: 'presenting', directionText: trial.direction === 'forward' ? '顺背' : '倒背', currentTrial: this._index + 1, answer: [], answerText: '', shownDigit: '' }); const showNext = () => { if (this._shownIndex >= trial.sequence.length) { this.setData({ phase: 'recall', shownDigit: '' }); return } this.setData({ shownDigit: String(trial.sequence[this._shownIndex]) }); this._shownIndex += 1; schedule(this, () => { this.setData({ shownDigit: '' }); schedule(this, showNext, this._config.gapMs) }, this._config.digitDurationMs) }; showNext() },
  handleDigitTap(event) { if (!this.data.running || this.data.phase !== 'recall') return; const answer = [...this.data.answer, Number(event.currentTarget.dataset.digit)]; this.setData({ answer, answerText: answer.join(' ') }) },
  handleDelete() { if (this.data.phase !== 'recall') return; const answer = this.data.answer.slice(0, -1); this.setData({ answer, answerText: answer.join(' ') }) },
  submitAnswer() { if (!this.data.running || this.data.phase !== 'recall') return; this._records.push(evaluateDigitTrial(this._trials[this._index], this.data.answer)); this._index += 1; this.setData({ progressPercent: Math.round((this._index / this._trials.length) * 100) }); if (this._index >= this._trials.length) return this._completeTest(); this.setData({ phase: 'feedback' }); schedule(this, () => this._presentTrial(), 450) },
  _completeTest() { clearTimers(this); const summary = summarizeDigitTrials(this._records); return finishPage(this, 'digit', buildDigitSpanPayload(summary, this._records, this._context), PENDING_KEY) },
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
