const { request } = require('../../utils/request')
const queue = require('../../utils/submission-queue')
const { coverageText } = require('../../utils/service-coverage-display')
const { page, positive, label, timeLabel, failureText, confirm, newId } = require('../../utils/transfer-page')
const clear = () => ({ items: [], detail: null, history: [], reason: '', evidenceText: '', resultText: '', trials: [] })
const metric = (value, suffix = '') => typeof value === 'number' && Number.isFinite(value) ? String(value) + suffix : '未报告'
function actualResult(evidence) {
  const result = evidence && evidence.server_result
  if (!result) return { resultText: '', trials: [] }
  if (result.kind === 'scale') return { resultText: `服务器计分：${metric(result.total_score, ' 分')}。量表计分不等同于诊断。`, trials: [] }
  if (result.kind !== 'cognitive') throw new Error('原结果类型需要核对。')
  const saved = result.result_json || {}, raw = saved.raw_result || {}, trials = Array.isArray(saved.trials) ? saved.trials : []
  const outcomes = { correct: '正确', incorrect: '错误', omission: '漏答', omitted: '漏答', false_start: '提前作答' }
  return { resultText: `服务器结果：正确率 ${metric(raw.accuracy, '%')}；实际保存 ${trials.length} 条试次；漏答 ${metric(raw.omissions)}。`,
    trials: trials.map((trial, index) => ({ key: index, number: index + 1, outcomeText: outcomes[trial.outcome] || '按原件核对', timeText: metric(trial.responseTimeMs, ' 毫秒') })) }
}
const decorate = work => ({ ...work, statusLabel: label(work.status), acceptedText: timeLabel(work.accepted_at), coverageText: coverageText(work.response_coverage),
  deadlineText: work.expected_response_at ? timeLabel(work.expected_response_at) : '未配置',
  suspensionText: work.suspension_reason === 'responsibility_transferred' ? '责任已交给下一位实际接受的医生，原记录保留。' : work.status === 'suspended' ?
    `本事项原授权或身份不可用，已暂停。${work.suspension_observation ? '后台核对：' + timeLabel(work.suspension_observation.observed_at) : ''}重新授权不会自动恢复。` : '',
  overdueText: work.overdue_observation && work.overdue_observation.human_action === false && work.overdue_observation.system_principal === 'care_transfer_maintenance'
    ? `原期望窗口已到，后台记录于 ${timeLabel(work.overdue_observation.observed_at)}。${work.overdue_observation.institutional_instructions}。外部通知尚未配置。` : '' })
Page(page({
  data: { ...clear(), patientId: 0, role: 'patient', busy: false, loading: false, pendingId: '', errorText: '', statusText: '', fallbackUrl: '/pages/home/index' },
  async reload() {
    const operation = this._begin(); if (!operation) return false
    this.setData({ loading: true, ...clear() }); this._detail = null
    try {
      const patientId = await this._patient(operation); if (!this._current(operation)) return false
      const doctor = this._owner.role === 'researcher'
      const result = await request({ url: '/care/transferred-work' + (doctor ? '' : `?patient_id=${patientId}`) })
      if (!this._current(operation)) return false
      if (!Array.isArray(result.items)) throw new Error('继任事项读取失败。')
      const items = result.items.map(work => {
        if (!positive(work.id) || !positive(work.patient_id) || work.original_provenance_preserved !== true ||
          (doctor ? work.responsible_doctor_id !== this._owner.id : work.patient_id !== patientId)) throw new Error('继任责任范围不一致。')
        return decorate(work)
      })
      this.setData({ items, patientId, busy: false, loading: false }); this._pending(['transfer_work_action']); return true
    } catch (failure) { if (this._current(operation)) this.setData({ busy: false, loading: false, errorText: failureText(failure) }); return false }
  },
  async openWork(event) {
    const id = Number(event.currentTarget.dataset.id), operation = this._begin(); if (!operation) return false
    try {
      const original = this.data.items.find(work => work.id === id)
      if (!original) throw new Error('请先刷新继任事项列表。')
      const detail = await request({ url: `/care/transferred-work/${id}` })
      if (!this._current(operation)) return false
      if (!detail.work || detail.work.id !== id || detail.work.patient_id !== original.patient_id || !Array.isArray(detail.allowed_actions)) throw new Error('继任事项详情不一致。')
      this._detail = detail
      const evidence = detail.original_evidence || {}, reasons = { execution_interrupted: '执行过程有中断', low_accuracy: '正确率较低', unknown_input: '输入方式未确认' }
      this.setData({ detail: { ...detail, work: decorate(detail.work), actions: detail.allowed_actions.map(action => ({ action, label: label(action) })) },
        items: this.data.items.map(item => item.id === id ? decorate(detail.work) : item), reason: '', history: [],
        ...actualResult(evidence.evidence),
        evidenceText: (evidence.quality_reasons || []).map(reason => reasons[reason] || reason).join('；') || '原事项材料已齐，请结合原件核对。' })
      const history = await request({ url: `/care/transferred-work/${id}/history` })
      if (!this._current(operation)) return false
      if (history.work_item_id !== id || !Array.isArray(history.items)) throw new Error('实际处理历史读取失败。')
      this.setData({ busy: false, history: history.items.map(item => ({ ...item, actionLabel: label(item.action), timeText: timeLabel(item.occurred_at) })) }); return true
    } catch (failure) { if (this._current(operation)) this.setData({ busy: false, errorText: failureText(failure) }); return false }
  },
  onReasonInput(event) { if (this._usable() && !this.data.busy && !this.data.pendingId) this.setData({ reason: String(event.detail.value).slice(0, 2000) }) },
  async act(event) {
    const action = event.currentTarget.dataset.action, detail = this._detail, operation = this._begin(); if (!operation) return false
    try {
      if (!detail || this.data.pendingId || !detail.allowed_actions.includes(action)) throw new Error('请重新读取当前事项和可执行动作。')
      const reason = this.data.reason.trim() || null
      if (action !== 'acknowledge' && !reason) throw new Error('解决或关闭事项需要实际说明。')
      const agreed = await confirm(label(action), `档案 ${detail.work.patient_id} · 继任事项 ${detail.work.id} · 版本 ${detail.work.version}\n${reason || '确认关注只记录本人已关注，仍需要后续实际处理。'}`)
      if (!this._current(operation)) return false
      if (!agreed) { this.setData({ busy: false }); return false }
      const id = newId('transfer-action')
      queue.enqueue({ id, kind: 'transfer_work_action', route: '/care/transferred-work-actions', expected_context_digest: detail.action_context_digest,
        payload: { client_action_id: id, patient_id: detail.work.patient_id, work_item_id: detail.work.id, expected_version: detail.work.version,
          action, reason, action_context: detail.action_context, confirmed: true } })
      this._pending(['transfer_work_action'])
      const ack = await queue.syncQueuedAcknowledgement(id)
      if (!this._current(operation)) return false
      this.setData({ busy: false }); this._pending(['transfer_work_action'])
      if (ack) {
        this.setData({ items: this.data.items.map(item => item.id === detail.work.id ? decorate({ ...item, status: ack.status, version: ack.version }) : item) })
        if (!await this._refreshAfter(operation, () => this.openWork({ currentTarget: { dataset: { id: detail.work.id } } }))) return false
      }
      else if (!this._current(operation)) return false
      this.setData({ statusText: ack ? '服务器已确认实际处理；历史以成功读取的记录为准。' : '原处理已保存，尚未获得确认；请按原编号查询。' }); return !!ack
    } catch (failure) { if (this._current(operation)) this.setData({ busy: false, errorText: failureText(failure) }); return false }
  },
  openTransfers() { if (!this._usable()) return false; wx.navigateTo({ url: '/pages/responsibility-transfers/index' + (this.data.patientId ? '?patient_id=' + this.data.patientId : '') }); return true }
}, clear))
