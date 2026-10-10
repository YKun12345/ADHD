const { clearTimers } = require('./cognitive-page-support')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('./session-privacy')

const READING_MS = 3000

function buildTaskInstruction(taskId, config) {
  const instructions = {
    reaction: { title: '反应抑制任务', purpose: '观察反应速度、注意保持与抑制控制。', method: '绿色页面出现时尽快点击测试页面；红色页面出现时保持不点击。', signals: '绿色“点击”表示需要点击；红色“停”表示请勿点击；白色表示等待或题目间隔，提前点击会记录为误触。', amount: `共 ${config.formalTrials} 次，连续完成，每次颜色显示最长 ${config.responseWindowMs} 毫秒。`, example: '页面变绿：点击后立即恢复白色。页面变红：等待它自行恢复白色。' },
    stroop: { title: '颜色干扰任务', purpose: '观察颜色选择、注意控制与冲突抑制。', method: '判断文字的实际颜色，忽略文字本身的含义，选择对应颜色按钮。', signals: '文字内容可能与显示颜色不同，只依据显示颜色作答。', amount: `共 ${config.formalTrials} 次连续完成，每次最多 ${config.responseWindowMs / 1000} 秒。`, example: '文字是“红”，实际颜色是蓝，应选择“蓝”。' },
    flanker: { title: '箭头抗干扰任务', purpose: '观察目标聚焦及忽略干扰的能力。', method: '只判断中间箭头向左还是向右，选择对应方向。', signals: '两侧箭头或菱形都是干扰符号；中央箭头才是目标。', amount: `共 ${config.formalTrials} 次连续完成，每次最多 ${config.responseWindowMs / 1000} 秒。`, example: '→ → ← → →：中央箭头向左，应选择“向左”。' },
    nback: { title: '两步位置记忆任务', purpose: '观察位置记忆的保持与更新。', method: '前两次点击黄色方格确认并记住位置。第三次起，判断当前位置是否与两次之前相同。', signals: '黄色是建立记忆的阶段；后续绿色方格是判断位置，选择“匹配”或“不匹配”。', amount: `共 ${config.formalTrials} 次连续呈现，前两次不计分，后 ${config.formalTrials - 2} 次计分。每次均由你的操作推进，没有超时跳题。`, example: '位置依次为左上、右下、左上：第三次应选择“匹配”。' },
    trail: { title: '连线测试', purpose: '观察视觉搜索、顺序执行与规则转换。', method: 'A阶段按数字顺序点击；A完成后阅读简短规则提示，自动进入B阶段，按数字和字母交替点击。点错后继续寻找当前正确目标。', signals: '已正确点击的节点会显示连接线；B阶段数字与字母交替。', amount: `A阶段 ${config.partANodes} 个数字；B阶段 ${config.partBPairs} 组、${config.partBPairs * 2} 个节点。分别记录两个阶段的用时和错误。`, example: `A：1、2、3…${config.partANodes}。B：1、A、2、B…${config.partBPairs}、${String.fromCharCode(64 + config.partBPairs)}。` },
    digit: { title: '数字广度测试', purpose: '观察短时记忆与信息操作能力。', method: '先看数字逐个出现，消失后用键盘输入并提交。顺背按原顺序，倒背按相反顺序。', signals: '数字显示时请记忆；显示输入键盘后才作答。注意当前标注的顺背或倒背规则。', amount: `顺背与倒背连续衔接，长度 ${config.minSpan}—${config.maxSpan} 位，每个长度 ${config.trialsPerSpan} 轮；同一长度两轮未答对会结束该方向。`, example: '看到2、7、4：顺背输入2、7、4；倒背输入4、7、2。' }
  }
  return instructions[taskId]
}

function clearInstructionTimer(page) {
  clearTimeout(page._instructionTimer)
  page._instructionTimer = null
  page._instructionEpoch = (page._instructionEpoch || 0) + 1
}

function showInstructions(page, taskId) {
  clearInstructionTimer(page)
  const epoch = page._instructionEpoch
  const lease = capturePatientSessionLease()
  page._instructionStartedAt = null
  page.setData({ instructionVisible: true, instructionReady: false, instructionRemaining: 3, taskInstruction: buildTaskInstruction(taskId, page._config) }, () => {
    const begin = () => {
      if (page._disposed || page._hidden || epoch !== page._instructionEpoch || !isPatientSessionLeaseCurrent(lease)) return
      page._instructionStartedAt = Date.now()
      const tick = () => {
        page._instructionTimer = null
        if (page._disposed || page._hidden || epoch !== page._instructionEpoch || !isPatientSessionLeaseCurrent(lease)) return
        const remaining = Math.max(0, Math.ceil((READING_MS - (Date.now() - page._instructionStartedAt)) / 1000))
        page.setData({ instructionRemaining: remaining, instructionReady: remaining === 0 })
        if (remaining) page._instructionTimer = setTimeout(tick, 1000)
      }
      page._instructionTimer = setTimeout(tick, 1000)
    }
    if (typeof wx.nextTick === 'function') wx.nextTick(begin)
    else begin()
  })
}

function withTaskInstructions(taskId, definition) {
  return {
    ...definition,
    data: { ...definition.data, instructionVisible: false, instructionReady: false, instructionRemaining: 3, taskInstruction: null },
    onLoad(query) {
      this._disposed = false
      this._hidden = false
      if (definition.onLoad) definition.onLoad.call(this, query)
      showInstructions(this, taskId)
    },
    onShow() {
      const wasHidden = this._hidden
      this._hidden = false
      if (definition.onShow) definition.onShow.call(this)
      const needsInstructions = this.data.instructionVisible || this.data.phase === 'intro' || this.data.phase === 'paused'
      if (wasHidden && needsInstructions && !this._disposed && !this.data.running && this._config) showInstructions(this, taskId)
    },
    startTest() {
      if (this._disposed || this._hidden || this.data.running || this.data.submitting) return
      if (!this.data.instructionVisible) { showInstructions(this, taskId); return }
      if (!this.data.instructionReady || this._instructionStartedAt === null || Date.now() - this._instructionStartedAt < READING_MS) return
      clearInstructionTimer(this)
      this._runGeneration = (this._runGeneration || 0) + 1
      this._completionSaved = false
      this._lastPayload = null
      this._runLease = capturePatientSessionLease()
      this._context.testRunId = `wx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
      this.setData({ instructionVisible: false })
      return definition.startTest.call(this)
    },
    handleInstructionStart() { return this.startTest() },
    onHide() {
      this._hidden = true
      this._runGeneration = (this._runGeneration || 0) + 1
      clearInstructionTimer(this)
      clearTimers(this)
      if (definition.onHide) definition.onHide.call(this)
      this.setData({ instructionReady: false })
    },
    onUnload() {
      this._disposed = true
      this._runGeneration = (this._runGeneration || 0) + 1
      clearInstructionTimer(this)
      clearTimers(this)
      if (definition.onUnload) definition.onUnload.call(this)
      this.setData({ running: false })
    },
    onPatientSessionEnded() {
      this._disposed = true
      this._runGeneration = (this._runGeneration || 0) + 1
      clearInstructionTimer(this)
      clearTimers(this)
      if (definition.onPatientSessionEnded) definition.onPatientSessionEnded.call(this)
      this._records = []
      this.setData({ running: false, instructionVisible: false, instructionReady: false, submitting: false })
    }
  }
}

module.exports = { READING_MS, buildTaskInstruction, withTaskInstructions }
