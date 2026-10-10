const { registerPatientPage } = require('../../utils/patient-page')
const { getTaskConfig } = require('../../utils/cognitive-config')
const { withTaskInstructions } = require('../../utils/cognitive-instructions')
const {
  buildTrailSequence,
  createTrailLayout,
  buildTrailPath,
  evaluateTrailTap,
  summarizeTrailStages,
  buildTrailPayload
} = require('../../utils/trail-test')
const { loadCognitiveContext, finishPage, retryPageSync, goNextBatteryTask, clearTimers, schedule } = require('../../utils/cognitive-page-support')

const PENDING_KEY = 'pending_trail_result'

registerPatientPage(withTaskInstructions('trail', {
  data: { patientName: '患者', ageGroup: 'child', mode: 'single', phase: 'intro', stage: 'A', stageTitle: '连线 A', running: false, submitting: false, nodes: [], nodeCount: 30, boardHeight: 400, boardReady: false, currentIndex: 0, progressPercent: 0, errors: 0, elapsedText: '0.0 秒', result: null, syncStatus: '', hasPendingResult: false, nextTaskId: '' },
  onLoad(query) { this._active = true; this._runToken = 0; this._context = loadCognitiveContext(query); this._config = getTaskConfig('trail', this._context.ageGroup); this.setData({ ...this._context, hasPendingResult: Boolean(wx.getStorageSync(PENDING_KEY)) }) },
  onShow() { this._active = true },
  startTest() {
    if (this.data.running || this.data.submitting || this.data.phase === 'transition') return
    clearTimers(this)
    this._active = true
    this._runToken = (this._runToken || 0) + 1
    this._finished = false
    this._stageResults = []
    this._allTaps = []
    this._startStage('A')
  },
  _startStage(stage) {
    const size = stage === 'A' ? this._config.partANodes : this._config.partBPairs
    this._sequence = buildTrailSequence(stage, size)
    this._stageToken = (this._stageToken || 0) + 1
    this._stageCompleted = false
    this._stageStartedAt = null
    this._layoutSeed = Math.floor(Math.random() * 4294967295) + 1
    this._currentIndex = 0
    this._tapBusy = false
    this._lastTap = null
    this._stageErrors = 0
    this.setData({
      phase: 'testing',
      stage,
      tapToken: `${this._runToken}-${this._stageToken}`,
      stageTitle: stage === 'A' ? '连线 A：按数字顺序' : '连线 B：数字与字母交替',
      running: true,
      nodes: [],
      nodeCount: this._sequence.length,
      boardReady: false,
      currentIndex: 0,
      progressPercent: 0,
      errors: 0,
      result: null,
      syncStatus: ''
    }, () => { this._scrollToTop(); this._layoutBoard(true) })
  },
  _scrollToTop() { if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 0 }) },
  _fallbackBoardWidth() {
    let info = {}
    if (typeof wx.getWindowInfo === 'function') info = wx.getWindowInfo()
    else if (typeof wx.getSystemInfoSync === 'function') info = wx.getSystemInfoSync()
    const windowWidth = Number(info.windowWidth) || 375
    return Math.max(160, windowWidth * 0.84)
  },
  _measureBoard(callback) {
    if (typeof wx.createSelectorQuery !== 'function') { callback(null); return }
    const query = wx.createSelectorQuery()
    const scopedQuery = query && typeof query.in === 'function' ? query.in(this) : query
    if (!scopedQuery || typeof scopedQuery.select !== 'function') { callback(null); return }
    const selection = scopedQuery.select('#trail-board')
    if (!selection || typeof selection.boundingClientRect !== 'function') { callback(null); return }
    selection.boundingClientRect(callback).exec()
  },
  _layoutBoard(startClock = false) {
    const runToken = this._runToken
    const stageToken = this._stageToken
    const layoutToken = this._layoutToken = (this._layoutToken || 0) + 1
    this._measureBoard((rect) => {
      if (!this._active || runToken !== this._runToken || stageToken !== this._stageToken || layoutToken !== this._layoutToken || this.data.phase !== 'testing') return
      const width = rect && Number(rect.width) > 0 ? Number(rect.width) : this._fallbackBoardWidth()
      const inset = 6
      const nodeSize = 40
      const gap = 10
      const columns = Math.max(1, Math.floor((width - inset * 2 + gap) / (nodeSize + gap)))
      const rows = Math.ceil(this._sequence.length / columns)
      const height = Math.max(360, Math.ceil(width * 1.35), rows * nodeSize + Math.max(0, rows - 1) * gap + inset * 2)
      const nodes = createTrailLayout(this._sequence, this._layoutSeed, { width: width - inset * 2, height: height - inset * 2, nodeSize, gap }).map((node) => ({
        ...node,
        x: (node.x / 100 * (width - inset * 2) + inset) / width * 100,
        y: (node.y / 100 * (height - inset * 2) + inset) / height * 100
      }))
      this.setData({ nodes, boardHeight: height, boardReady: true }, () => {
        if (!this._active || runToken !== this._runToken || stageToken !== this._stageToken || layoutToken !== this._layoutToken || this.data.phase !== 'testing') return
        if (startClock || !Number.isFinite(this._stageStartedAt)) this._stageStartedAt = Date.now()
        this._drawTrailPath(this._currentIndex)
      })
    })
  },
  _drawTrailPath(completedCount) {
    if (typeof wx.createSelectorQuery !== 'function' || typeof wx.createCanvasContext !== 'function') return
    const runToken = this._runToken
    const stageToken = this._stageToken
    const drawToken = this._drawToken = (this._drawToken || 0) + 1
    const segments = buildTrailPath(this.data.nodes, completedCount)
    this._measureBoard((rect) => {
      if (!this._active || runToken !== this._runToken || stageToken !== this._stageToken || drawToken !== this._drawToken || this.data.phase !== 'testing') return
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
    })
  },
  handleNodeTap(event) {
    if (!this._active || !this.data.running || !this.data.boardReady || this.data.phase !== 'testing' || this._tapBusy || this._stageCompleted) return
    if (event.currentTarget.dataset.tapToken !== undefined && event.currentTarget.dataset.tapToken !== this.data.tapToken) return
    const label = String(event.currentTarget.dataset.label)
    const node = this.data.nodes.find((item) => item.label === label)
    if (!node) return
    const now = Date.now()
    if (this._lastTap && this._lastTap.label === label && now - this._lastTap.at < 200) return
    this._lastTap = { label, at: now }
    this._tapBusy = true
    const runToken = this._runToken
    const stageToken = this._stageToken
    const releaseTap = () => {
      if (runToken === this._runToken && stageToken === this._stageToken) this._tapBusy = false
    }
    const outcome = evaluateTrailTap(this._sequence, this._currentIndex, label)
    this._allTaps.push({ stage: this.data.stage, label, expected: this._sequence[this._currentIndex], correct: outcome.correct, elapsedMs: now - this._stageStartedAt })
    if (!outcome.correct) { this._stageErrors += 1; this.setData({ errors: this._stageErrors }, releaseTap); return }
    this._currentIndex = outcome.nextIndex
    this.setData({
      currentIndex: outcome.nextIndex,
      progressPercent: Math.round((outcome.nextIndex / this._sequence.length) * 100)
    }, () => {
      releaseTap()
      if (runToken === this._runToken && stageToken === this._stageToken) this._drawTrailPath(outcome.nextIndex)
    })
    if (outcome.completed) this._completeStage()
  },
  _completeStage() {
    if (!this._active || this._stageCompleted || this._finished || this.data.phase !== 'testing' || this._currentIndex < this._sequence.length) return
    this._stageCompleted = true
    const elapsedMs = Date.now() - this._stageStartedAt
    this._stageResults.push({ stage: this.data.stage, elapsedMs, errors: this._stageErrors, nodeCount: this._sequence.length, completed: true })
    if (this.data.stage === 'A') {
      const runToken = this._runToken
      const stageToken = this._stageToken
      this.setData({ phase: 'transition', running: false, elapsedText: `${(elapsedMs / 1000).toFixed(1)} 秒` }, () => this._scrollToTop())
      schedule(this, () => {
        if (this._active && this._runToken === runToken && this._stageToken === stageToken && this.data.phase === 'transition') this._startStage('B')
      }, 2000)
      return
    }
    this._finished = true
    clearTimers(this)
    const summary = summarizeTrailStages(this._stageResults)
    const actualNodes = this._stageResults.reduce((total, item) => total + (Number(item.nodeCount) || 0), 0)
    const completion = finishPage(this, 'trail', buildTrailPayload(summary, this._allTaps, this._context), PENDING_KEY, actualNodes)
    this._scrollToTop()
    return completion
  },
  onResize() { if (this._active && this.data.phase === 'testing') this._layoutBoard(false) },
  retrySync() { return retryPageSync(this, PENDING_KEY) },
  goNext() { goNextBatteryTask(this) },
  goBack() { wx.navigateBack({ delta: 1 }) },
  onHide() {
    this._active = false
    this._runToken = (this._runToken || 0) + 1
    this._drawToken = (this._drawToken || 0) + 1
    clearTimers(this)
    if (this.data.running || this.data.phase === 'transition') {
      this._context.interruptedCount = (Number(this._context.interruptedCount) || 0) + 1
      this.setData({ running: false, phase: 'paused' })
    }
  },
  onUnload() { this._active = false; this._runToken = (this._runToken || 0) + 1; clearTimers(this) }
}))
