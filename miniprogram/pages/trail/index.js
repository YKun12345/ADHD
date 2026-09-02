const { registerPatientPage } = require('../../utils/patient-page')
const { getTaskConfig } = require('../../utils/cognitive-config')
const {
  buildTrailSequence,
  createRandomTrailLayout,
  buildTrailPath,
  evaluateTrailTap,
  summarizeTrailStages,
  buildTrailPayload
} = require('../../utils/trail-test')
const { loadCognitiveContext, finishPage, retryPageSync, goNextBatteryTask, clearTimers } = require('../../utils/cognitive-page-support')

const PENDING_KEY = 'pending_trail_result'

registerPatientPage({
  data: { patientName: '患者', ageGroup: 'child', mode: 'single', phase: 'intro', stage: 'A', stageTitle: '连线 A', running: false, submitting: false, nodes: [], currentIndex: 0, progressPercent: 0, errors: 0, elapsedText: '0.0 秒', result: null, syncStatus: '', hasPendingResult: false, nextTaskId: '' },
  onLoad(query) { this._context = loadCognitiveContext(query); this._config = getTaskConfig('trail', this._context.ageGroup); this.setData({ ...this._context, hasPendingResult: Boolean(wx.getStorageSync(PENDING_KEY)) }) },
  startTest() { if (this.data.running || this.data.submitting) return; this._stageResults = []; this._allTaps = []; this._startStage('A') },
  _startStage(stage) {
    const size = stage === 'A' ? this._config.partANodes : this._config.partBPairs
    this._sequence = buildTrailSequence(stage, size)
    this._stageStartedAt = Date.now()
    this._stageErrors = 0
    this.setData({
      phase: 'testing',
      stage,
      stageTitle: stage === 'A' ? '连线 A：按数字顺序' : '连线 B：数字与字母交替',
      running: true,
      nodes: createRandomTrailLayout(this._sequence),
      currentIndex: 0,
      progressPercent: 0,
      errors: 0,
      result: null,
      syncStatus: ''
    }, () => this._drawTrailPath(0))
  },
  _drawTrailPath(completedCount) {
    if (typeof wx.createSelectorQuery !== 'function' || typeof wx.createCanvasContext !== 'function') return
    const segments = buildTrailPath(this.data.nodes, completedCount)
    const query = wx.createSelectorQuery()
    const scopedQuery = query && typeof query.in === 'function' ? query.in(this) : query
    if (!scopedQuery || typeof scopedQuery.select !== 'function') return
    const selection = scopedQuery.select('#trail-board')
    if (!selection || typeof selection.boundingClientRect !== 'function') return
    selection.boundingClientRect((rect) => {
      if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return
      const context = wx.createCanvasContext('trail-lines', this)
      if (!context) return
      context.clearRect(0, 0, rect.width, rect.height)
      if (segments.length) {
        context.setStrokeStyle('#3f8b7f')
        context.setLineWidth(4)
        context.setLineCap('round')
        context.setLineJoin('round')
        context.beginPath()
        segments.forEach((segment) => {
          context.moveTo((segment.from.x / 100) * rect.width, (segment.from.y / 100) * rect.height)
          context.lineTo((segment.to.x / 100) * rect.width, (segment.to.y / 100) * rect.height)
        })
        context.stroke()
      }
      context.draw()
    }).exec()
  },
  handleNodeTap(event) {
    if (!this.data.running || this.data.phase !== 'testing') return
    const label = String(event.currentTarget.dataset.label)
    const outcome = evaluateTrailTap(this._sequence, this.data.currentIndex, label)
    this._allTaps.push({ stage: this.data.stage, label, expected: this._sequence[this.data.currentIndex], correct: outcome.correct, elapsedMs: Date.now() - this._stageStartedAt })
    if (!outcome.correct) { this._stageErrors += 1; this.setData({ errors: this._stageErrors }); return }
    this.setData({
      currentIndex: outcome.nextIndex,
      progressPercent: Math.round((outcome.nextIndex / this._sequence.length) * 100)
    }, () => this._drawTrailPath(outcome.nextIndex))
    if (outcome.completed) this._completeStage()
  },
  _completeStage() {
    const elapsedMs = Date.now() - this._stageStartedAt
    this._stageResults.push({ stage: this.data.stage, elapsedMs, errors: this._stageErrors, nodeCount: this._sequence.length, completed: true })
    if (this.data.stage === 'A') { this.setData({ phase: 'rest', running: false, elapsedText: `${(elapsedMs / 1000).toFixed(1)} 秒` }); return }
    const summary = summarizeTrailStages(this._stageResults)
    const actualNodes = this._stageResults.reduce((total, item) => total + (Number(item.nodeCount) || 0), 0)
    return finishPage(this, 'trail', buildTrailPayload(summary, this._allTaps, this._context), PENDING_KEY, actualNodes)
  },
  continuePartB() { if (this.data.phase === 'rest') this._startStage('B') },
  retrySync() { return retryPageSync(this, PENDING_KEY) },
  goNext() { goNextBatteryTask(this) },
  goBack() { wx.navigateBack({ delta: 1 }) },
  onHide() {
    if (this.data.running) {
      this._context.interruptedCount = (Number(this._context.interruptedCount) || 0) + 1
      this.setData({ running: false, phase: 'paused' })
    }
  },
  onUnload() { clearTimers(this) }
})
