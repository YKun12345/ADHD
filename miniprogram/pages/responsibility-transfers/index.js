const { request } = require('../../utils/request')
const queue = require('../../utils/submission-queue')
const { page, positive, label, timeLabel, failureText, confirm, newId } = require('../../utils/transfer-page')
const clear = () => ({ sources: [], receivers: [], requests: [], selectedSources: [], receiverIndex: -1, reason: '', detail: null })
Page(page({
  data: { ...clear(), patientId: 0, role: 'patient', busy: false, loading: false, pendingId: '', errorText: '', statusText: '', fallbackUrl: '/pages/home/index' },
  async reload() {
    const operation = this._begin(); if (!operation) return false
    this.setData({ loading: true, ...clear() }); this._detail = null
    try {
      const patientId = await this._patient(operation); if (!this._current(operation)) return false
      const doctor = this._owner.role === 'researcher'
      const requests = await request({ url: '/care/responsibility-transfers' + (doctor ? '' : `?patient_id=${patientId}`) })
      if (!this._current(operation)) return false
      if (!Array.isArray(requests.items)) throw new Error('交接列表需要重新核对。')
      let options = { sources: [], receiving_relationships: [] }
      if (!doctor) options = await request({ url: `/care/responsibility-transfers/options?patient_id=${patientId}` })
      if (!this._current(operation)) return false
      if (!Array.isArray(options.sources) || !Array.isArray(options.receiving_relationships)) throw new Error('对象或接收医生列表读取失败。')
      this._options = options
      this.setData({ patientId, sources: options.sources.map(s => ({ ...s, key: `${s.source_type}:${s.source_id}`,
        label: `${s.kind === 'evidence_review' ? '材料待审核' : '临床关注'} ${s.source_id} · 原负责医生账号 ${s.from_doctor_user_id} · 版本 ${s.expected_version}` })),
        receivers: options.receiving_relationships.map(r => ({ ...r, label: `${r.doctor_name || '医生账号 ' + r.doctor_user_id} · ${r.institution_id}` })),
        requests: requests.items.map(item => {
          if (!item.request || !positive(item.request.id) || (!doctor && item.request.patient_id !== patientId) ||
            (doctor && item.request.receiver_doctor_user_id !== this._owner.id)) throw new Error('交接列表身份不一致。')
          return { id: item.request.id, patientId: item.request.patient_id, doctorId: item.request.receiver_doctor_user_id,
            count: item.request.sources.length, statusLabel: label(item.status), timeText: timeLabel(item.request.requested_at) }
        }), loading: false, busy: false })
      this._pending(['transfer_request', 'transfer_decision']); return true
    } catch (failure) {
      if (!this._current(operation)) return false
      this.setData({ loading: false, busy: false, errorText: failureText(failure) }); return false
    }
  },
  selectSources(event) {
    if (!this._usable() || this.data.busy || this.data.pendingId) return false
    const selected = event.detail.value
    if (!Array.isArray(selected) || selected.some(key => !this.data.sources.some(s => s.key === key))) return false
    this.setData({ selectedSources: selected }); return true
  },
  selectReceiver(event) {
    if (!this._usable() || this.data.busy || this.data.pendingId) return false
    const index = Number(event.detail.value)
    if (!Number.isInteger(index) || !this.data.receivers[index]) return false
    this.setData({ receiverIndex: index }); return true
  },
  onReasonInput(event) { if (this._usable() && !this.data.busy && !this.data.pendingId) this.setData({ reason: String(event.detail.value).slice(0, 2000) }) },
  async propose() {
    const operation = this._begin(); if (!operation) return false
    try {
      if (this._owner.role !== 'patient' || this.data.pendingId) throw new Error('请先核对原提交。')
      const receiver = this.data.receivers[this.data.receiverIndex]
      const sources = this.data.sources.filter(s => this.data.selectedSources.includes(s.key)).map(s => ({ source_type: s.source_type, source_id: s.source_id, expected_version: s.expected_version }))
        .sort((a, b) => a.source_type.localeCompare(b.source_type) || a.source_id - b.source_id)
      if (!receiver || !sources.length) throw new Error('请明确选择事项和接收医生。')
      const body = { patient_id: this.data.patientId, receiving_relationship_id: receiver.relationship_id, sources, reason: this.data.reason.trim() || null }
      const preflight = await request({ url: '/care/responsibility-transfers/preflight', method: 'POST', data: body })
      if (!this._current(operation)) return false
      if (preflight.receiver_doctor_user_id !== receiver.doctor_user_id || !Array.isArray(preflight.sources) || preflight.sources.length !== sources.length) throw new Error('服务器接收范围需重新核对。')
      const agreed = await confirm('确认交接范围', `接收方：${receiver.label}\n仅交接所选 ${sources.length} 项：${sources.map(s => s.source_type === 'attention' ? '关注 ' + s.source_id : '继任事项 ' + s.source_id).join('、')}。\n接收医生接受后才生效；旧评估和计划不会自动恢复。`)
      if (!this._current(operation)) return false
      if (!agreed) { this.setData({ busy: false }); return false }
      const id = newId('transfer-request')
      queue.enqueue({ id, kind: 'transfer_request', route: '/care/responsibility-transfers', expected_context_digest: preflight.request_context_digest,
        payload: { ...body, client_transfer_id: id, request_context: preflight.request_context, confirmed: true } })
      this._pending(['transfer_request', 'transfer_decision'])
      const ack = await queue.syncQueuedAcknowledgement(id)
      if (!this._current(operation)) return false
      this.setData({ busy: false }); this._pending(['transfer_request', 'transfer_decision'])
      if (ack ? !await this._refreshAfter(operation) : !this._current(operation)) return false
      this.setData({ statusText: ack ? '服务器已确认交接请求，等待接收医生实际接受。' : '原交接请求已保存，尚未获得确认；请按原编号查询。' })
      return !!ack
    } catch (failure) {
      if (this._current(operation)) this.setData({ busy: false, errorText: failureText(failure) })
      return false
    }
  },
  async openRequest(event) {
    const id = Number(event.currentTarget.dataset.id), operation = this._begin(); if (!operation) return false
    try {
      if (!this.data.requests.some(r => r.id === id)) throw new Error('请先刷新交接列表。')
      const result = await request({ url: `/care/responsibility-transfers/${id}` })
      if (!this._current(operation)) return false
      if (!result.request || result.request.id !== id || !Array.isArray(result.allowed_actions)) throw new Error('交接详情不一致。')
      this._detail = result
      this.setData({ busy: false, reason: '', detail: { ...result, statusLabel: label(result.status),
        sourcesText: result.request.sources.map(s => `${s.source_type === 'attention' ? '关注' : '继任事项'} ${s.source_id} · 原版本 ${s.expected_version}`).join('；'),
        actions: result.allowed_actions.map(action => ({ action, label: label(action) })),
        decisionText: result.decision ? `${label(result.status)} · 实际账号 ${result.decision.actor_user_id} · ${timeLabel(result.decision.decided_at)}${result.decision.reason ? ' · ' + result.decision.reason : ''}` : '' } })
      return true
    } catch (failure) { if (this._current(operation)) this.setData({ busy: false, errorText: failureText(failure) }); return false }
  },
  async decide(event) {
    const action = event.currentTarget.dataset.action, detail = this._detail, operation = this._begin(); if (!operation) return false
    try {
      if (!detail || this.data.pendingId || !detail.allowed_actions.includes(action)) throw new Error('请重新读取当前可执行决定。')
      const reason = this.data.reason.trim() || null
      if (action !== 'accept' && !reason) throw new Error('请填写实际拒绝或撤销原因。')
      const agreed = await confirm(label(action), `档案 ${detail.request.patient_id} · 交接 ${detail.request.id} · 接收医生账号 ${detail.request.receiver_doctor_user_id}\n${this.data.detail.sourcesText}\n${reason || '接受后生成所选事项的新待办，原来源和旧安排保留。'}`)
      if (!this._current(operation)) return false
      if (!agreed) { this.setData({ busy: false }); return false }
      const id = newId('transfer-decision')
      queue.enqueue({ id, kind: 'transfer_decision', route: '/care/responsibility-transfer-decisions', expected_context_digest: detail.decision_context_digest,
        payload: { client_decision_id: id, patient_id: detail.request.patient_id, transfer_id: detail.request.id, expected_version: detail.version,
          decision: action, reason, decision_context: detail.decision_context, confirmed: true } })
      this._pending(['transfer_request', 'transfer_decision'])
      const ack = await queue.syncQueuedAcknowledgement(id)
      if (!this._current(operation)) return false
      this.setData({ busy: false }); this._pending(['transfer_request', 'transfer_decision'])
      if (ack ? !await this._refreshAfter(operation) : !this._current(operation)) return false
      this.setData({ statusText: ack ? `服务器已确认：${label(ack.status)}。` : '原决定已保存，尚未获得确认；请按原编号查询。' }); return !!ack
    } catch (failure) { if (this._current(operation)) this.setData({ busy: false, errorText: failureText(failure) }); return false }
  },
  openWork() { if (!this._usable()) return false; wx.navigateTo({ url: '/pages/transferred-work/index' + (this.data.patientId ? '?patient_id=' + this.data.patientId : '') }); return true }
}, clear))
