const { registerPatientPage } = require('../../utils/patient-page')
const { request } = require('../../utils/request')
const {
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
} = require('../../utils/session-privacy')
const asrsScale = require('../../utils/asrs-scale')
const snapScale = require('../../utils/snap-scale')
const execution = require('../../utils/assessment-execution')
const submissionQueue = require('../../utils/submission-queue')
const {
  SCALE_LATEST_RESULT_KEY,
  isReportableScaleResult
} = require('../../utils/report-data')

const SCALE_MODELS = {
  adult: {
    draftKey: asrsScale.ASRS_DRAFT_KEY,
    config: asrsScale.ASRS_CONFIG,
    instructions: '请根据近 6 个月的实际情况作答',
    scaleKicker: '行为量表 · 成人版',
    normalizeDraftAnswers: asrsScale.normalizeDraftAnswers,
    setAnswer: asrsScale.setAnswer,
    getQuestionState: asrsScale.getQuestionState,
    buildScalePayload: asrsScale.buildScalePayload
  },
  child: {
    draftKey: snapScale.SNAP_DRAFT_KEY,
    config: snapScale.SNAP_CONFIG,
    instructions: snapScale.SNAP_CONFIG.instructions,
    scaleKicker: '行为量表 · 儿童版',
    normalizeDraftAnswers: snapScale.normalizeDraftAnswers,
    setAnswer: snapScale.setAnswer,
    getQuestionState: snapScale.getQuestionState,
    buildScalePayload: snapScale.buildScalePayload
  }
}

const RISK_LABELS = {
  low: '低风险',
  medium: '中等风险',
  high: '高风险'
}

function isCompleteResult(result) {
  return Boolean(
    result &&
    Number.isFinite(result.total_score) &&
    typeof result.risk_level === 'string' &&
    typeof result.summary === 'string' &&
    Array.isArray(result.recommendations)
  )
}

registerPatientPage({
  data: {
    patientName: '患者',
    patientSupported: false,
    unsupportedMessage: '',
    title: asrsScale.ASRS_CONFIG.title,
    instructions: '请根据近 6 个月的实际情况作答',
    scaleKicker: '行为量表 · 成人版',
    estimatedMinutes: asrsScale.ASRS_CONFIG.estimatedMinutes,
    options: asrsScale.ASRS_CONFIG.options,
    answers: [],
    currentIndex: 0,
    questionNumber: 1,
    totalQuestions: asrsScale.ASRS_CONFIG.questions.length,
    currentQuestion: asrsScale.ASRS_CONFIG.questions[0],
    selectedValue: null,
    progressPercent: 6,
    isFirstQuestion: true,
    isLastQuestion: false,
    submitting: false,
    showResult: false,
    result: null,
    resultRiskLabel: '', formalExecution: false, formalQueued: false, formalCommitted: false, formalStatus: '',
    draftStatus: '答案自动保存在本机'
  },

  onLoad(query = {}) {
    this._scaleActive = true
    if (['assessment_id', 'item_id', 'attempt_id'].some(key => query[key] !== undefined)) {
      this._formalQuery = query
      return this._loadFormalScale()
    }
    const user = wx.getStorageSync('current_user') || {}
    const patientProfile = user.patient_profile || {}
    const patientType = String(
      patientProfile.patient_type || ''
    ).toLowerCase()

    if (user.full_name) {
      this.setData({
        patientName: user.full_name
      })
    }

    const scaleModel = SCALE_MODELS[patientType]

    if (!scaleModel) {
      this.setData({
        patientSupported: false,
        unsupportedMessage:
          '暂时无法识别患者量表类型，请返回首页后重试。'
      })
      return
    }

    this.scaleModel = scaleModel
    this.draftKey = scaleModel.draftKey

    const answers = scaleModel.normalizeDraftAnswers(
      wx.getStorageSync(scaleModel.draftKey)
    )
    const currentIndex = answers.length >= scaleModel.config.questions.length
      ? scaleModel.config.questions.length - 1
      : answers.length

    this.setData({
      patientSupported: true,
      unsupportedMessage: '',
      title: scaleModel.config.title,
      instructions: scaleModel.instructions,
      scaleKicker: scaleModel.scaleKicker,
      estimatedMinutes: scaleModel.config.estimatedMinutes,
      options: scaleModel.config.options,
      answers,
      ...scaleModel.getQuestionState(currentIndex, answers)
    })
  },

  async _loadFormalScale() {
    const epoch = this._scaleEpoch = (this._scaleEpoch || 0) + 1, lease = capturePatientSessionLease()
    this.setData({ formalExecution: true, patientSupported: false, unsupportedMessage: '正在核对本轮量表与填写者…' })
    try {
      const context = await execution.loadExecution(this._formalQuery, 'scale')
      if (!this._scaleActive || this._scaleEpoch !== epoch || !isPatientSessionLeaseCurrent(lease)) return false
      const model = SCALE_MODELS[context.attempt.age_group], config = context.attempt.config_snapshot
      if (!model || config.scaleType !== model.config.scaleType || config.respondentType !== model.config.respondentType ||
        config.maxScore !== model.config.maxScore || JSON.stringify(config.questions) !== JSON.stringify(model.config.questions) ||
        JSON.stringify(config.options) !== JSON.stringify(model.config.options) || context.item.recall_window !== 'P6M') throw new Error('当前客户端量表内容与服务器冻结版本不一致，请更新后重新进入。')
      this._execution = context
      this.scaleModel = model
      const queued = submissionQueue.pendingEntries().find(row => row.kind === 'assessment' && row.payload.attempt_id === context.attempt.id)
      this._formalSubmission = queued && queued.payload
      const answers = model.normalizeDraftAnswers(queued ? queued.payload.content.answers : execution.readScaleDraft(context))
      this.setData({ patientSupported: true, unsupportedMessage: '', title: config.title, instructions: model.instructions,
        scaleKicker: model.scaleKicker, estimatedMinutes: config.estimatedMinutes, options: config.options, answers,
        formalQueued: Boolean(queued), formalCommitted: false, formalStatus: queued ? '本次原始提交尚未确认，可以原样重试。' : '',
        ...model.getQuestionState(Math.min(answers.length, config.questions.length - 1), answers) })
      return true
    } catch (error) {
      if (this._scaleActive && this._scaleEpoch === epoch && isPatientSessionLeaseCurrent(lease)) this.setData({ patientSupported: false, unsupportedMessage: error.message || '量表读取失败，请返回本轮评估重试。' })
      return false
    }
  },
  onShow() { if (this._formalQuery && !this._scaleActive) { this._scaleActive = true; return this._loadFormalScale() } },
  onHide() {
    if (!this._formalQuery) return
    this._scaleActive = false; this._scaleEpoch = (this._scaleEpoch || 0) + 1
    this._execution = null; this._formalSubmission = null
    this.setData({ answers: [], result: null, showResult: false, formalCommitted: false, formalQueued: false, patientSupported: false, submitting: false })
  },
  onUnload() { this.onHide() },

  selectOption(event) {
    if (this.data.submitting || this.data.formalQueued || this.data.formalCommitted) return

    const value = Number(event.currentTarget.dataset.value)
    if (!this.scaleModel) {
      return
    }

    const answers = this.scaleModel.setAnswer(
      this.data.answers,
      this.data.currentIndex,
      value
    )

    if (answers[this.data.currentIndex] !== value) {
      return
    }

    this.setData({
      answers,
      ...this.scaleModel.getQuestionState(
        this.data.currentIndex,
        answers
      )
    })
    try {
      if (this._execution) execution.saveScaleDraft(this._execution, answers)
      else wx.setStorageSync(this.draftKey, answers)
      this.setData({ draftStatus: '答案已保存在本机' })
    } catch (_) { this.setData({ draftStatus: '答案尚未保存，请保留页面并重试。' }) }
  },

  goPrevious() {
    if (this.data.isFirstQuestion || this.data.submitting) {
      return
    }

    this.setData({
      ...this.scaleModel.getQuestionState(
        this.data.currentIndex - 1,
        this.data.answers
      )
    })
  },

  goNext() {
    if (this.data.submitting) {
      return
    }

    if (this.data.selectedValue === null) {
      wx.showToast({
        title: '请先选择本题答案',
        icon: 'none'
      })
      return
    }

    if (this.data.isLastQuestion) {
      return this.submitScale()
    }

    this.setData({
      ...this.scaleModel.getQuestionState(
        this.data.currentIndex + 1,
        this.data.answers
      )
    })
  },

  async submitScale() {
    if (this.data.submitting) {
      return
    }

    if (!this.scaleModel) {
      return
    }

    const payload = this.scaleModel.buildScalePayload(
      this.data.answers
    )

    if (!payload) {
      const firstMissingIndex = this.scaleModel.config.questions.findIndex(
        (_, index) => !Number.isInteger(this.data.answers[index])
      )
      this.setData({
        ...this.scaleModel.getQuestionState(
          firstMissingIndex >= 0 ? firstMissingIndex : 0,
          this.data.answers
        )
      })
      const totalQuestions = Number.isInteger(this.data.totalQuestions)
        ? this.data.totalQuestions
        : this.scaleModel.config.questions.length
      wx.showToast({
        title: `请完成全部${totalQuestions}道题目`,
        icon: 'none'
      })
      return
    }

    if (this._execution) return this._submitFormalScale(payload)

    this.setData({
      submitting: true
    })
    const lease = capturePatientSessionLease()

    try {
      const result = await request({
        url: '/patient/submit_scale',
        method: 'POST',
        data: payload
      })
      if (!isPatientSessionLeaseCurrent(lease)) return

      if (!isCompleteResult(result)) {
        throw new Error('INCOMPLETE_SCALE_RESULT')
      }

      if (isReportableScaleResult(result)) {
        wx.setStorageSync(SCALE_LATEST_RESULT_KEY, result)
      }

      wx.removeStorageSync(this.draftKey)
      this.setData({
        result,
        resultRiskLabel:
          RISK_LABELS[result.risk_level] || result.risk_level,
        showResult: true,
        submitting: false
      })
    } catch (error) {
      if (!isPatientSessionLeaseCurrent(lease)) return
      this.setData({
        submitting: false
      })
      wx.showToast({
        title: '量表提交失败，答案已保留',
        icon: 'none',
        duration: 2500
      })
    }
  },

  async _submitFormalScale(payload) {
    const lease = capturePatientSessionLease(), epoch = this._scaleEpoch
    const current = () => this._scaleActive && this._scaleEpoch === epoch && isPatientSessionLeaseCurrent(lease)
    this.setData({ submitting: true, formalStatus: '正在保存原始提交…' })
    try {
      const original = this._formalSubmission || execution.buildSubmission(this._execution, { scale_type: payload.scale_type,
        answers: payload.answers, recall_window: 'P6M', content_digest: this._execution.item.content_digest })
      submissionQueue.enqueue({ id: original.submission_id, kind: 'assessment', route: '/care/submissions', payload: original })
      this._formalSubmission = original
      this.setData({ formalQueued: true, formalStatus: '已保存在本机，正在请求服务器确认…' })
      const ack = await submissionQueue.syncQueuedAcknowledgement(original.submission_id)
      if (!current()) return false
      if (!ack) {
        const pending = submissionQueue.pendingEntries().find(row => row.id === original.submission_id)
        this.setData({ submitting: false, formalStatus: pending && pending.status === 'authorization_blocked' ? '授权已失效，尚未提交，请核对授权。'
          : pending && pending.status === 'conflict_blocked' ? '提交内容冲突，请核对服务器记录。' : '尚未取得服务器确认，原始答案已保留，可原样重试。' })
        return false
      }
      this.setData({ formalQueued: false, formalCommitted: true, formalStatus: `服务器已确认提交 · ${ack.quality_status === 'valid' ? '质量有效' : '质量待核对'} · ${ack.acceptance_status === 'pending_review' ? '待医生验收' : '无需医生验收'}` })
      try { execution.clearScaleDraft(this._execution) } catch (_) { /* The committed server receipt is authoritative. */ }
      const evidence = await request({ url: `/care/submissions/${encodeURIComponent(original.submission_id)}/evidence` })
      if (!current()) return true
      if (!evidence || evidence.submission_id !== original.submission_id || !evidence.server_result || evidence.server_result.id !== ack.result.id ||
        evidence.server_result.kind !== 'scale' || evidence.server_result.legacy !== false || !evidence.context ||
        ['patient_id', 'assessment_id', 'assessment_item_id', 'attempt_id', 'run_id'].some(key => evidence.context[key] !== original[key])) throw new Error('已提交，结果读取尚未核对成功，请返回本轮评估重读。')
      this.setData({ result: evidence.server_result, resultRiskLabel: RISK_LABELS[evidence.server_result.risk_level] || '待核对', submitting: false })
      return true
    } catch (error) {
      if (current()) this.setData({ submitting: false, formalStatus: this.data.formalCommitted ? '已提交，结果读取暂未完成，请返回本轮评估重读。' : error.message || '本机保存失败，请保留页面并重试。' })
      return false
    }
  },

  goBack() {
    wx.navigateBack({
      delta: 1
    })
  }
})

module.exports = {
  isCompleteResult
}
