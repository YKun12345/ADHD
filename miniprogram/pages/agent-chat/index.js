const { request } = require('../../utils/request')
const { protectPatientPage } = require('../../utils/patient-page')
const { hasValidAnySession } = require('../../utils/role-session')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const { normalizeInitialPrompt } = require('../../utils/ai-chat')
const queue = require('../../utils/submission-queue')
const { targetUrl } = require('../../utils/agent-actions')
const { presentRun, helpPrompts, serviceView } = require('../../utils/xingzai-chat')
const { orderedActions } = require('../../utils/xingzai-actions')
const { profileRows, profileContent, adoptionUrl } = require('../../utils/agent-adoption')
const { methods: companionMethods, companionView } = require('../../utils/companion-chat-flow')
const { suggestedIntents } = require('../../utils/companion-intent')
const dialogue = require('../../utils/companion-dialogue')
const positive = value => Number.isInteger(Number(value)) && Number(value) > 0
const idFor = () => `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 13)}`
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value
const sameFields = (a,b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b))
const COMMON = [{ value: 'question', label: '和星仔聊聊' }, { value: 'assessment_summary', label: '帮我整理评估材料' }, { value: 'cycle_summary', label: '帮我回顾最近记录' }]
const DOCTOR = [{ value: 'review_questions', label: '帮我准备补问' }, { value: 'plan_draft', label: '帮我起草计划' }, { value: 'reply_draft', label: '帮我准备回复' }]
const PERSONAL = [{ value: 'profile_fields', label: '逐项整理我提供的背景' }]
const blank = () => ({ profiles: [], profileIndex: 0, assessments: [], assessmentIndex: 0, runs: [], inputValue: '', pendingId: '', editor: null,
  editorText: '', editorTitle: '', editorReason: '', adoptedDecision: null, decisionHistory: [], busy: false, loading: false, errorText: '', statusText: '',
  moreVisible: false, visibleRuns: [], historyLimit: 8, nextActions: [], nextAction: null, nextActionIndex: 0,
  cycles: [], cycleIndex: 0, profileInputFields: profileRows(), editorFields: [], isProfileInput: false, isCycleInput: false, profileAllowed: false,
  actionNote: '', hasRunning: false, welcomeText: '你好，我是星仔。我会帮你用好这个小程序，也可以聊聊分心、拖延等注意力相关困惑。我们从你现在的问题开始。',
  petState: 'idle', petText: '', quickPrompts: [], keyboardHeight: 0, needsExternalConsent: false,
  companion: null, contextChoices: [], selectedContextIds: [], smartPreview: null, businessChoices: [], businessOptions: [], businessDraft: null, petActive: true, reducedMotion: false })
Page(protectPatientPage({
  ...companionMethods,
  data: { ...blank(), role: '', patientId: 0, patientFixed: false, assessmentId: null, cycleId: null, intents: COMMON, intentIndex: 0 },
  onLoad(options = {}) {
    this._active = true; this._lease = capturePatientSessionLease(); const actor = wx.getStorageSync('current_user') || {}
    this._actor = actor.id; this._role = actor.role; this._runId = null
    this._initialPrompt = normalizeInitialPrompt(options.prompt)
    this.setData({ role: actor.role, patientId: positive(options.patient_id) ? Number(options.patient_id) : 0,
      patientFixed: positive(options.patient_id), assessmentId: positive(options.assessment_id) ? Number(options.assessment_id) : null,
      cycleId: positive(options.cycle_id) ? Number(options.cycle_id) : null, intents: actor.role === 'researcher' ? COMMON.concat(DOCTOR) : COMMON.concat(PERSONAL),
      inputValue: this._initialPrompt, quickPrompts: helpPrompts(actor.role), ...serviceView(actor.role) })
    return this.reload()
  },
  onShow() { if (this._ended) return false; this._active = true; return this.reload() },
  onHide() { this._active = false; this._epoch = (this._epoch || 0) + 1; clearTimeout(this._pollTimer); clearTimeout(this._petTimer); this._runId = null;
    this._initialPrompt = ''; this._pollStarted = 0; this._editContext = null; this._preparedSmart = null; this._businessDraft = null; this._businessOptions = [];
    this.setData({ ...blank(), petActive: false }) },
  onUnload() { this._ended = true; this.onHide() },
  usable() { const actor = wx.getStorageSync('current_user') || {}; const ok = !this._ended && this._active && actor.id === this._actor &&
    actor.role === this._role && hasValidAnySession() && isPatientSessionLeaseCurrent(this._lease)
    if (!ok && this._active) { this._ended = true; this.onHide() } return ok },
  current(epoch) { return this.usable() && this._epoch === epoch },
  _clearDecision() {
    this._editContext = null
    this.setData({ editor: null, editorText: '', editorTitle: '', editorReason: '', adoptedDecision: null,
      decisionHistory: [], editorFields: [], statusText: '' })
  },
  _pending() { const row = queue.pendingEntries().find(item => ['agent_run','artifact_decision'].includes(item.kind) && item.payload.patient_id === this.data.patientId)
    this.setData({ pendingId: row ? row.id : '' }) },
  _render(row) {
    if (!row || row.actor_user_id !== this._actor || row.patient_id !== this.data.patientId || !positive(row.run_id)) throw new Error('助手记录归属不一致。')
    const artifact = row.artifact, summary = artifact && artifact.body && artifact.body.summary
    if (artifact && (artifact.actor_user_id !== this._actor || artifact.patient_id !== this.data.patientId || artifact.run_id !== row.run_id || artifact.status !== 'draft')) throw new Error('助手草稿来源不一致。')
    return { ...row, ...presentRun(row, this._role), detailsVisible: Boolean(this.data.runs.find(value => value.run_id === row.run_id)?.detailsVisible),
      modeLabel: artifact?.body?.draft_method === 'local_structured_rules' ? '根据本轮实际材料整理的编辑建议，待医生核对' : row.mode === 'rules' ? '本机帮助' : row.mode === 'remote' ? '模型辅助解答' : ['failed','stale'].includes(row.status) ? '运行未完成' : '后台运行',
      originalText: row.intent === 'profile_fields' ? '请星仔逐项核对本次背景资料。' : row.original_message,
      replyText: artifact && artifact.body.reply || '', questionDrafts: artifact && artifact.body.questions || [],
      planDraft: artifact && artifact.body.plan_draft || null, replyDraft: artifact && artifact.body.reply_draft || null,
      sourceText: row.question_mode === 'smart' ? row.context_run_ids?.length ? '本次文字及逐次确认的选中对话；其他档案和医疗原件未附带' : '本次已确认的文字；没有向模型发送历史聊天或医疗原件' : artifact ? artifact.source_refs.map(value => { const fields = value.split(':'); return fields[0] === 'assessment' ? `评估第 ${fields[1]} 轮（版本 ${fields[2]}）`
        : fields[0] === 'report' ? `已发布报告 ${fields[1]}（第 ${fields[2]} 版）` : fields[0] === 'plan' ? `医生计划 ${fields[1]}`
          : fields[0] === 'cycle' ? `实际日期周期 ${fields[1]}` : fields[0] === 'submission' ? '本轮实际提交原件' : '当前获准档案' }).join('；') : '',
      dispositionText: artifact && artifact.latest_decision ? ({ adopt: '本人已核对采纳，业务仍须单独确认', edit: '本人已编辑核对，业务仍须单独确认', reject: '本人已明确拒绝本草稿' })[artifact.latest_decision.decision] : '',
      summaryText: summary ? `${row.question_mode === 'smart' ? '本机记录汇总（未发送给模型）：' : ''}实际提交 ${summary.submitted_items} 项；质量有效 ${summary.valid_submissions} 份，有局限 ${summary.limited_submissions} 份；尚缺 ${summary.missing_items} 项。` : '' }
  },
  async _history(epoch) {
    const result = await request({ url: `/agent/runs?patient_id=${this.data.patientId}` }); if (!this.current(epoch)) return false
    if (result.actor_user_id !== this._actor || result.patient_id !== this.data.patientId || !Array.isArray(result.items)) throw new Error('助手历史归属不一致。')
    const runs = result.items.map(row => this._render(row)); this.setData({ runs }); this._syncConversation()
    const active = runs.slice().reverse().find(row => ['queued', 'running'].includes(row.status))
    this._runId = active ? active.run_id : null
    if (active) this._schedulePoll()
    else if (this.data.statusText === '收到啦，星仔正在看看。') this.setData({ statusText: '' })
    return true
  },
  async reload() {
    if (!this.usable() || this.data.loading || this.data.busy) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; clearTimeout(this._pollTimer); this._clearDecision(); this._clearCompanionInput()
    this.setData({ petActive: true, loading: true, runs: [], visibleRuns: [], nextActions: [], nextAction: null, companion: null, errorText: '', quickPrompts: helpPrompts(this._role), ...serviceView(this._role) })
    try {
      if (!this.data.patientFixed || !this.data.patientId) {
        const context = await request({ url: this._role === 'researcher' ? '/doctor/my_patients' : '/identity/context' }); if (!this.current(epoch)) return false
        const rows = this._role === 'researcher' ? context.items : context.accessible_patients
        if (!Array.isArray(rows)) throw new Error('档案列表不完整。')
        const profiles = rows.filter(row => positive(row.patient_id)).map(row => ({ patient_id: row.patient_id, label: row.display_name || row.patient_name || `获准档案 ${row.patient_id}` }))
        if (!profiles.length) { this.setData({ loading: false, profiles: [], statusText: '请先确认本人、监护或医患共享关系。' }); return false }
        const index = Math.max(0, profiles.findIndex(row => row.patient_id === this.data.patientId))
        this.setData({ profiles, profileIndex: index, patientId: profiles[index].patient_id })
      }
      this._pending()
      const frame = await request({ url: `/agent/context?patient_id=${this.data.patientId}` }); if (!this.current(epoch)) return false
      if (frame.actor_user_id !== this._actor || frame.patient_id !== this.data.patientId || !Array.isArray(frame.assessments)) throw new Error('助手评估选择来源不一致。')
      const assessments = [{ id: null, label: '全部获准评估（仅汇总）' }, ...frame.assessments.filter(row => this._role !== 'researcher' || row.responsible_doctor_id === this._actor)
        .map(row => ({ id: row.id, label: `第 ${row.id} 轮 · ${row.age_group === 'child' ? '儿童' : '成人'}` }))]
      const assessmentIndex = Math.max(0, assessments.findIndex(row => row.id === this.data.assessmentId))
      const cycles = (frame.cycles || []).map(row => ({ id: row.id, label: `${row.cycle_type === 'professional' ? '医生计划' : '自助'}周期 ${row.id} · ${row.start_date} 至 ${row.end_date}` }))
      const cycleIndex = Math.max(0, cycles.findIndex(row => row.id === this.data.cycleId))
      this.setData({ assessments, assessmentIndex, assessmentId: assessments[assessmentIndex].id, cycles, cycleIndex,
        cycleId: cycles.length ? cycles[cycleIndex].id : null, profileAllowed: (frame.authorized_scopes || []).includes('profile') })
      await this._history(epoch); if (!this.current(epoch)) return false
      await this._loadNext(epoch); if (!this.current(epoch)) return false
      this.setData({ loading: false }); this._restoreCompanionReturn(); return true
    } catch (failure) { if (this.current(epoch)) this.setData({ loading: false, runs: [], errorText: failure.message || '助手暂未读取成功，其他业务页面仍可使用。' }); return false }
  },
  async selectProfile(event) {
    if (!this.usable() || this.data.busy || this.data.smartPreview) return false
    const row = this.data.profiles[Number(event.detail.value)]; if (!row) return false
    this._epoch = (this._epoch || 0) + 1; clearTimeout(this._pollTimer); this._runId = null
    this._clearDecision()
    this.setData({ patientId: row.patient_id, assessmentId: null, cycleId: null, inputValue: '', profileInputFields: profileRows(), runs: [], visibleRuns: [], nextActions: [], nextAction: null, moreVisible: false, loading: false }); return this.reload()
  },
  onInput(event) { if (this.usable() && !this.data.busy && !this.data.pendingId && !this.data.smartPreview) {
    this._businessDraft = null; this._businessOptions = []
    this.setData({ inputValue: event.detail.value, petState: event.detail.value ? 'listening' : 'idle', businessChoices: suggestedIntents(event.detail.value, this._role), businessDraft: null, businessOptions: [] }) } },
  selectIntent(event) { const value = Number(event.detail.value); if (this.usable() && !this.data.busy && !this.data.smartPreview && this.data.intents[value]) this.setData({ intentIndex: value,
    isProfileInput: this.data.intents[value].value === 'profile_fields', isCycleInput: this.data.intents[value].value === 'cycle_summary' }) },
  selectCycle(event) { const index = Number(event.detail.value), row = this.data.cycles[index]; if (this.usable() && !this.data.busy && !this.data.pendingId && !this.data.smartPreview && row) {
    this._clearDecision(); this.setData({ cycleIndex: index, cycleId: row.id }) } },
  onProfileField(event) {
    if (!this.usable() || this.data.busy || this.data.pendingId) return false
    const scope = event.currentTarget.dataset.scope === 'editor' ? 'editorFields' : 'profileInputFields', index = Number(event.currentTarget.dataset.index)
    if (!this.data[scope][index] || scope === 'profileInputFields' && !this.data.profileAllowed) return false
    const type = event.currentTarget.dataset.type, value = event.detail.value
    const rows = this.data[scope].map((row, i) => i !== index ? row : type === 'confirmed' ? { ...row, confirmed: value.includes('confirmed') }
      : type === 'status' && ['provided','unknown','skipped'].includes(value) ? { ...row, status: value, value: value === 'provided' ? row.value : '', confirmed: false }
        : type === 'value' ? { ...row, value, confirmed: false } : row)
    this.setData({ [scope]: rows }); return true
  },
  selectAssessment(event) { const index = Number(event.detail.value), row = this.data.assessments[index]
    if (this.usable() && !this.data.busy && !this.data.pendingId && !this.data.smartPreview && row) {
      this._epoch = (this._epoch || 0) + 1; clearTimeout(this._pollTimer); this._runId = null; this._clearDecision(); this._clearCompanionInput()
      this.setData({ assessmentIndex: index, assessmentId: row.id })
      this.setData({ nextActions: [], nextAction: null }); this._loadNext(this._epoch)
    } },
  send() { return this._send(false) },
  sendSmart() { return this._send(true) },
  async _send(smart) {
    if (!this.usable() || this.data.busy || this.data.loading || this.data.hasRunning || this.data.pendingId || this.data.smartPreview || !this.data.patientId || !this.data.isProfileInput && !this.data.inputValue.trim()) return false
    if (smart && this.data.intents[this.data.intentIndex].value !== 'question') return false
    if (['review_questions','plan_draft','reply_draft'].includes(this.data.intents[this.data.intentIndex].value) && !this.data.assessmentId) {
      this.setData({ moreVisible: true, errorText: '请先在上方选择本人实际负责的具体评估，再准备专业草稿。' }); return false }
    if (this.data.isCycleInput && !this.data.cycleId) { this.setData({ errorText: '请先选择一个实际日期周期。' }); return false }
    if (this.data.isProfileInput && (!this.data.profileAllowed || this.data.profileInputFields.some(row => row.status === 'provided' && !row.value.trim()))) {
      this.setData({ errorText: '请核对背景处理授权，并填写选择提供的项目；也可以不知道或跳过。' }); return false }
    const epoch = this._epoch = (this._epoch || 0) + 1, message = this.data.isProfileInput ? JSON.stringify(profileContent(this.data.profileInputFields).fields) : this.data.inputValue, id = idFor()
    if (message.length > 4000) { this.setData({ errorText: '本次背景内容较长，请缩短至合计4000字内再整理。' }); return false }
    this.setData({ busy: true, errorText: '', statusText: '', needsExternalConsent: false })
    try {
      const intent = this.data.intents[this.data.intentIndex].value
      const mode = intent === 'question' ? `&question_mode=${smart ? 'smart' : 'local'}` : ''
      const ids = smart ? this.data.selectedContextIds.slice() : []
      const selection = ids.map(value => `&context_run_ids=${value}`).join('')
      const ctx = await request({ url: `/agent/run-context?patient_id=${this.data.patientId}${mode}${selection}` }); if (!this.current(epoch)) return false
      if (ctx.actor_user_id !== this._actor || ctx.role !== this._role || ctx.patient_id !== this.data.patientId) throw new Error('助手运行上下文与当前账号不一致。')
      if (smart) {
        if (ctx.question_mode !== 'smart' || !ctx.external_ai || ctx.external_ai.field_policy_version !== (ids.length ? dialogue.POLICY : 'Xingzai-current-message-1')) {
          this.setData({ needsExternalConsent: true })
          throw new Error(this._role === 'researcher' ? '这份档案尚未同意外部 AI 的任务和消息用途，请由本人或已核验监护人在账号与隐私中授权。' : '请先在账号与隐私中同意外部 AI 的任务和消息用途。每条智能回答仍会单独确认。')
        }
        if (ctx.question_provider_status !== 'ready') throw new Error('智能回答服务或调用额度尚未配置，请联系管理员；仍可使用普通发送。')
        if (ids.length) {
          const preview = dialogue.verifiedPreview(ctx, ids, this.data.runs)
          this._preparedSmart = { epoch, message, id, intent, ctx, smart, ids }
          this.setData({ busy: false, smartPreview: { ...preview, message }, moreVisible: false }); this._scrollToLatest(); return false
        }
        const confirmed = await new Promise(resolve => wx.showModal({ title: '发送本次文字给 DeepSeek？',
          content: `将下面这次输入交给 DeepSeek 回答，不附带历史聊天、姓名、档案或报告。文字中若自行包含私人资料，也会一并发送。\n\n${message.slice(0, 180)}${message.length > 180 ? `…（共${message.length}字，完整内容在输入框）` : ''}`,
          confirmText: '确认发送', cancelText: '暂不发送', success: result => resolve(result.confirm === true), fail: () => resolve(false) }))
        if (!this.current(epoch)) return false
        if (!confirmed) { this.setData({ busy: false }); return false }
      }
      return this._submitPrepared({ epoch, message, id, intent, ctx, smart, ids })
    } catch (failure) { if (this.current(epoch)) this.setData({ busy: false, errorText: failure.message || '请求尚未保存，请保留内容。' }); return false }
  },
  async _submitPrepared({ epoch, message, id, intent, ctx, smart, ids }) {
    if (!this.current(epoch)) return false
    try {
      queue.enqueue({ id, kind: 'agent_run', route: '/agent/runs', expected_context_digest: ctx.run_context_digest,
        payload: { client_run_id: id, patient_id: this.data.patientId, intent,
          assessment_id: intent === 'profile_fields' ? null : this.data.assessmentId, cycle_id: intent === 'cycle_summary' ? this.data.cycleId : null, message, expected_context_digest: ctx.input_digest, run_context: ctx.run_context,
          ...(smart ? { external_message_consent: { version: ids.length ? dialogue.POLICY : 'Xingzai-current-message-1', confirmed: true }, ...(ids.length ? { context_run_ids: ids } : {}) } : {}) } })
      this._pending(); const ack = await queue.syncQueuedAcknowledgement(id); if (!this.current(epoch)) return false
      this.setData({ busy: false }); this._pending()
      if (!ack) { this.setData({ statusText: '请求原件已保存在本机，尚未确认后台接收。请按原编号查询。' }); return false }
      this._clearCompanionInput()
      this.setData({ inputValue: '', intentIndex: 0, isProfileInput: false, isCycleInput: false, profileInputFields: profileRows(), moreVisible: false, statusText: '收到啦，星仔正在看看。' })
      this._pollStarted = Date.now(); await this._history(epoch); this._scrollToLatest(); return true
    } catch (failure) { if (this.current(epoch)) this.setData({ busy: false, errorText: failure.message || '请求尚未保存，请保留内容。' }); return false }
  },
  openAIConsent() { if (this.usable() && this._role === 'patient' && !this.data.busy) wx.navigateTo({ url: '/pages/privacy-settings/index' }) },
  async queryPending() {
    if (!this.usable() || this.data.busy || !this.data.pendingId) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true })
    const kind = queue.pendingEntries().find(row => row.id === this.data.pendingId)?.kind
    const ack = await queue.queryQueuedAcknowledgement(this.data.pendingId); if (!this.current(epoch)) return false
    this.setData({ busy: false }); this._pending()
    if (ack) { this._pollStarted = Date.now(); if (kind === 'artifact_decision') await this.readyDecision(ack, epoch)
      else this.setData({ inputValue: '', intentIndex: 0 }); await this._history(epoch) } return Boolean(ack)
  },
  _schedulePoll() {
    clearTimeout(this._pollTimer)
    if (!this._pollStarted) this._pollStarted = Date.now()
    if (Date.now() - this._pollStarted >= 65000) { this.setData({ statusText: '后台记录仍可查询，请稍后刷新；当前没有把等待当作完成。' }); return }
    this._pollTimer = setTimeout(() => { if (this.usable()) this.refreshRun() }, 1500)
    if (this._pollTimer && typeof this._pollTimer.unref === 'function') this._pollTimer.unref()
  },
  async refreshRun() {
    if (!this.usable() || this.data.busy || this.data.loading || !this._runId) return false
    const epoch = this._epoch = (this._epoch || 0) + 1, id = this._runId
    try { const result = await request({ url: `/agent/runs/${id}` }); if (!this.current(epoch)) return false
      const row = this._render(result); this.setData({ runs: this.data.runs.map(value => value.run_id === id ? row : value) }); this._syncConversation()
      if (['queued', 'running'].includes(row.status)) this._schedulePoll(); else { this._runId = null;
        clearTimeout(this._petTimer)
        this.setData({ statusText: '', petState: row.status === 'completed' ? 'success' : 'care' })
        this._petTimer = setTimeout(() => { if (this.usable()) this.setData({ petState: 'idle', petText: '' }) }, 3500)
        await this._loadNext(epoch); if (this.current(epoch)) this._scrollToLatest() }
      return true
    } catch (failure) { if (this.current(epoch)) this.setData({ errorText: failure.message || '后台状态暂未读取，请刷新。' }); return false }
  },
  _syncConversation() {
    this.setData({ visibleRuns: this.data.runs.slice(-this.data.historyLimit), hasRunning: this.data.runs.some(row => ['queued', 'running'].includes(row.status)) })
    this._refreshContextChoices()
  },
  async _loadNext(epoch) {
    const pid = this.data.patientId
    try {
      const result = await request({ url: `/agent/actions?patient_id=${pid}` }); if (!this.current(epoch)) return false
      if (result.actor_user_id !== this._actor || result.patient_id !== pid || !Array.isArray(result.items)) throw new Error('下一步归属不一致。')
      result.items.forEach(row => {
        if (!positive(row.id) || row.patient_id !== pid || row.actor_user_id !== this._actor || row.status !== 'available') throw new Error('下一步来源已变化。')
        targetUrl(row.target, { role: this._role, patientId: pid })
      })
      const scoped = result.items.filter(row => !this.data.assessmentId || !row.target.params.assessment_id || row.target.params.assessment_id === this.data.assessmentId)
      const actions = orderedActions(scoped, null, this._role), companion = companionView(result.companion, actions)
      if (companion?.resume_action_id) { const index = actions.findIndex(row => row.id === companion.resume_action_id); actions.unshift(actions.splice(index, 1)[0]) }
      this.setData({ nextActions: actions, nextAction: actions[0] || null, nextActionIndex: 0,
        actionNote: result.mode === 'history_only' ? '现在先陪你查看已有记录；新的操作需要有效授权。' : '' })
      this._showCompanion(companion, epoch)
      return true
    } catch (_) {
      if (this.current(epoch)) this.setData({ nextActions: [], nextAction: null, actionNote: '下一步暂时没有读到，你仍可以和我聊聊。' })
      return false
    }
  },
  async openNextAction() {
    if (!this.usable() || this.data.busy || this.data.loading || this.data.pendingId || !this.data.nextAction) return false
    const row = this.data.nextAction, pid = this.data.patientId, epoch = this._epoch = (this._epoch || 0) + 1
    this.setData({ busy: true, errorText: '' })
    try {
      const result = await request({ url: `/agent/actions/${row.id}/resolve`, method: 'POST', data: { patient_id: pid, expected_action_digest: row.action_digest } })
      if (!this.current(epoch)) return false
      if (result.action_id !== row.id || result.patient_id !== pid || result.action_digest !== row.action_digest || result.revalidated !== true ||
          JSON.stringify(result.target) !== JSON.stringify(row.target)) throw new Error('这一步的资料有变化，我们刷新后再继续。')
      const url = targetUrl(result.target, { role: this._role, patientId: pid })
      this.setData({ busy: false }); wx.navigateTo({ url }); return true
    } catch (failure) { if (this.current(epoch)) this.setData({ busy: false, nextAction: null, nextActions: [], errorText: failure.message || '暂时没有打开，我们稍后再试。' }); return false }
  },
  nextSuggestion() {
    if (!this.usable() || this.data.busy || this.data.pendingId || this.data.nextActions.length < 2) return false
    const index = (this.data.nextActionIndex + 1) % this.data.nextActions.length
    this.setData({ nextActionIndex: index, nextAction: this.data.nextActions[index] }); return true
  },
  toggleMore() { if (this.usable()) this.setData({ moreVisible: !this.data.moreVisible }) },
  closeMore() { this.setData({ moreVisible: false }) },
  showEarlier() { if (this.usable()) { this.setData({ historyLimit: this.data.historyLimit + 8 }); this._syncConversation() } },
  toggleRunDetails(event) {
    if (!this.usable()) return
    const id = Number(event.currentTarget.dataset.id)
    this.setData({ runs: this.data.runs.map(row => row.run_id === id ? { ...row, detailsVisible: !row.detailsVisible } : row) }); this._syncConversation()
  },
  showHelpPrompt(event) {
    if (this.usable() && !this.data.busy && !this.data.pendingId && !this.data.smartPreview) {
      const inputValue = event.currentTarget.dataset.text || ''
      this._businessDraft = null; this._businessOptions = []
      this.setData({ intentIndex: 0, inputValue, moreVisible: false, businessDraft: null, businessOptions: [], businessChoices: suggestedIntents(inputValue, this._role) }) }
  },
  petXingzai(event) {
    if (!this.usable()) return
    clearTimeout(this._petTimer)
    const lines = ['我在这里，陪你慢慢来。', '一次做一小步就很好。想先聊聊哪里卡住了吗？', '收到你的摸摸啦。需要帮助时直接告诉我。']
    this._petCount = (this._petCount || 0) + 1
    const reactions = { blink: '眨眨眼，我在呢。', tilt: '歪歪头，想听听你的想法。', wave: '挥挥手，给你打个招呼。' }
    this.setData({ petText: event?.detail?.accepted === false ? '我正陪你处理这一步，稍后再玩。' : reactions[event?.detail?.reaction] || lines[(this._petCount - 1) % lines.length] })
    this._petTimer = setTimeout(() => { if (this.usable()) this.setData({ petState: 'idle', petText: '' }) }, 3500)
  },
  touchXingzai() {
    if (!this.usable()) return false
    const mascot = this.selectComponent?.('#chat-pet')
    if (!mascot || typeof mascot.onInteract !== 'function') return false
    mascot.onInteract(); return true
  },
  onComposerFocus(event) { if (this.usable()) this.setData({ keyboardHeight: Math.max(0, Number(event.detail.height) || 0), petState: 'listening' }) },
  onComposerBlur() { this.setData({ keyboardHeight: 0, petState: 'idle' }) },
  _scrollToLatest() { if (this.usable() && typeof wx.pageScrollTo === 'function') wx.nextTick(() => { if (this.usable()) wx.pageScrollTo({ scrollTop: 999999, duration: 180 }) }) },
  async openEditor(event) {
    if (!this.usable() || this.data.busy || this.data.pendingId) return false
    const id = Number(event.currentTarget.dataset.id), run = this.data.runs.find(row => row.artifact && row.artifact.id === id)
    if (!run || run.artifact.stale) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, editor: null, errorText: '' }); clearTimeout(this._pollTimer)
    try {
      const ctx = await request({ url: `/agent/artifacts/${id}/decision-context` }); if (!this.current(epoch)) return false
      if (ctx.artifact_id !== id || ctx.actor_user_id !== this._actor || ctx.patient_id !== this.data.patientId || ctx.input_digest !== run.input_digest) throw new Error('草稿人工核对上下文不一致。')
      this._editContext = ctx
      const value = ctx.default_content || {}, isPlan = ctx.kind === 'plan_draft'
      this.setData({ busy: false, editor: { artifactId: id, kind: ctx.kind, isPlan,
        isProfile: ctx.kind === 'profile_fields', canUse: ctx.allowed_decisions.includes('adopt'),
        maxLength: ['assessment_summary','cycle_summary'].includes(ctx.kind) ? 8000 : isPlan ? 4000 : 2000,
        sourceText: ctx.kind === 'profile_fields' ? '本次本人主动提供的背景' : ctx.kind === 'cycle_summary' ? `实际日期周期 ${ctx.cycle_id}` : value.source_key || (value.source_report_id ? `已发布报告 ${value.source_report_id}` : `当前实际评估 ${ctx.assessment_id}`) },
        editorFields: ctx.kind === 'profile_fields' ? profileRows(value) : [],
        editorTitle: value.title || '', editorText: value.question || value.instructions || value.text || '', editorReason: '', adoptedDecision: null }); return true
    } catch (failure) { if (this.current(epoch)) this.setData({ busy: false, errorText: failure.message || '草稿尚不能核对。' }); return false }
  },
  onEditorInput(event) { const field = event.currentTarget.dataset.field
    if (this.usable() && !this.data.busy && !this.data.pendingId && ['editorText','editorTitle','editorReason'].includes(field)) this.setData({ [field]: event.detail.value }) },
  async saveEditor(event) {
    if (!this.usable() || this.data.busy || this.data.pendingId || !this.data.editor || !this._editContext) return false
    const use = event.currentTarget.dataset.action === 'use', ctx = this._editContext
    if (use && !this.data.editor.canUse) return false
    if (!this.data.editorReason.trim() || use && ctx.kind !== 'profile_fields' && !this.data.editorText.trim()) { this.setData({ errorText: '请填写实际核对原因和需要使用的内容。' }); return false }
    if (use && ctx.kind === 'profile_fields' && this.data.editorFields.some(row => !row.confirmed || row.status === 'provided' && !row.value.trim())) {
      this.setData({ errorText: '请逐项核对并勾选确认；不知道和跳过仍需确认状态。' }); return false }
    if (use && ctx.kind === 'plan_draft' && !this.data.editorTitle.trim()) { this.setData({ errorText: '请填写本人核对的实际计划标题。' }); return false }
    const content = !use ? null : ctx.kind === 'profile_fields' ? profileContent(this.data.editorFields) : ctx.kind === 'review_questions' ? { ...ctx.default_content, question: this.data.editorText }
      : ctx.kind === 'plan_draft' ? { ...ctx.default_content, title: this.data.editorTitle, instructions: this.data.editorText } : { text: this.data.editorText }
    const decision = use ? sameFields(content,ctx.default_content) ? 'adopt' : 'edit' : 'reject'
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, errorText: '' })
    try {
      const agreed = await new Promise(resolve => wx.showModal({ title: '确认人工核对决定', content: use ? '保存本人核对的草稿；业务操作还需进入对应表单再次明确确认。' : '记录本人拒绝该草稿；不会发送消息或发布意见。',
        success: result => resolve(result.confirm === true), fail: () => resolve(false) }))
      if (!this.current(epoch)) return false
      if (!agreed) { this.setData({ busy: false }); return false }
      const id = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,13)}`
      queue.enqueue({ id, kind: 'artifact_decision', route: '/agent/artifact-decisions', expected_context_digest: ctx.decision_context_digest,
        payload: { client_decision_id: id, patient_id: this.data.patientId, artifact_id: ctx.artifact_id, expected_previous_version: ctx.expected_previous_version,
          decision_context: ctx.decision_context, decision, content, reason: this.data.editorReason, confirmed: true,
          ...(use && ctx.kind === 'profile_fields' ? { confirmed_fields: this.data.editorFields.map(row => row.key) } : {}) } }); this._pending()
      const ack = await queue.syncQueuedAcknowledgement(id); if (!this.current(epoch)) return false
      this.setData({ busy: false }); this._pending()
      if (!ack) { this.setData({ statusText: '人工核对原件已保留，服务器确认待查询；不会自动提出问题。' }); return false }
      await this.readyDecision(ack, epoch); await this._history(epoch); return true
    } catch (failure) { if (this.current(epoch)) this.setData({ busy: false, errorText: failure.message || '人工决定尚未保存，请保留原件。' }); return false }
  },
  async readyDecision(ack, epoch) {
    this._editContext = null; this.setData({ editor: null, editorText: '', editorTitle: '', editorReason: '', editorFields: [], adoptedDecision: null })
    if (ack.decision === 'reject') { this.setData({ statusText: '已记录拒绝，未发起任何专业业务。' }); return true }
    try {
    const actual = await request({ url: `/agent/artifact-decisions/${ack.id}/adoption-context` }); if (!this.current(epoch)) return false
    if (actual.id !== ack.id || actual.actor_user_id !== this._actor || actual.patient_id !== this.data.patientId || !adoptionUrl(actual)) throw new Error('已核对草稿的实际后续对象不一致。')
    this.setData({ adoptedDecision: actual, statusText: '草稿已核对保存，进入实际业务表单后再明确确认。' }); return true
    } catch (failure) { if (this.current(epoch)) this.setData({ adoptedDecision: null, statusText: '人工决定已保存；当前材料或权限需要重新核对，暂不能带入业务表单。' }); return false }
  },
  async viewDecisions(event) {
    if (!this.usable() || this.data.busy) return false
    const id = Number(event.currentTarget.dataset.id); if (!this.data.runs.some(row => row.artifact && row.artifact.id === id)) return false
    const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, decisionHistory: [], errorText: '' })
    try {
      const value = await request({ url: `/agent/artifacts/${id}/decisions` }); if (!this.current(epoch)) return false
      if (value.artifact_id !== id || value.patient_id !== this.data.patientId || value.actor_user_id !== this._actor || !Array.isArray(value.items) ||
        value.items.some(row => row.artifact_id !== id || row.patient_id !== this.data.patientId || row.actor_user_id !== this._actor)) throw new Error('人工核对历史归属不一致。')
      this.setData({ busy: false, decisionHistory: value.items.map(row => ({ ...row, label: ({ adopt:'本人采纳',edit:'本人编辑',reject:'本人拒绝' })[row.decision],
        contentText: row.content ? row.content.question || row.content.instructions || row.content.text || '' : '' })) }); return true
    } catch (failure) { if (this.current(epoch)) this.setData({ busy: false, decisionHistory: [], errorText: failure.message || '人工核对记录暂未读到。' }); return false }
  },
  openDecision() { if (!this.usable() || !this.data.adoptedDecision || this.data.busy) return false
    const row = this.data.adoptedDecision
    if (row.patient_id !== this.data.patientId || row.target_type === 'cycle_review' && row.cycle_id !== this.data.cycleId || !['cycle_review','assessment_background'].includes(row.target_type) && row.assessment_id !== this.data.assessmentId) { this._clearDecision(); return false }
    const url = adoptionUrl(row); if (!url) return false
    wx.navigateTo({ url }); return true },
  openRecovery() { if (this.usable()) wx.navigateTo({ url: '/pages/submission-queue/index' }) }
}, () => hasValidAnySession()))
