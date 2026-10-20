// Only the current page's input survives an in-app assistant round trip.
// No drafts, tokens or clinical context are written to shared storage.
const states = new WeakMap(), pages = new Set()
const LIMIT = 15 * 60 * 1000
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const fields = {
  'doctor-plan': ['title', 'instructions', 'startDate', 'endDate'],
  'doctor-review': ['body', 'limitations', 'category'],
  'review-questions': ['questionText', 'answerStatus', 'answerText', 'sourceIndex'],
  'shared-messages': ['content'],
  'care-cycles': ['startDate', 'endDate', 'focusMinutes', 'note', 'moodTag', 'sleepQuality', 'originalTime'],
  'cycle-review': ['body', 'limitations', 'reason', 'title', 'instructions', 'startDate', 'endDate', 'decisionIndex'],
  assessments: ['backgroundFields'],
  'imaging-reports': ['body', 'limitations']
}
const readMethods = {
  'review-questions': ['selectQuestion'], 'shared-messages': ['selectPatient', 'selectRelationship'],
  'care-cycles': ['openCycle', 'selectRecordDate'], 'imaging-reports': ['review'], assessments: ['selectTemplate']
}
function owner() { try { const user = wx.getStorageSync('current_user') || {}; return `${user.role}:${user.id}` } catch (_) { return '' } }
function current(page, state) {
  return !page._ended && owner() === state.owner &&
    require('./session-privacy').isPatientSessionLeaseCurrent(state.lease)
}
function selection(page) {
  const d = page.data
  return { patientId: d.patientId, assessmentId: d.assessmentId || d.assessment?.id, cycleId: d.cycleId || d.cycle?.id,
    questionId: d.selectedQuestion?.id, relationshipId: d.relationshipId, reportId: d.selected?.id,
    recordDate: d.recordDate, templateId: d.selectedTemplateId }
}
function form(page, key) {
  const value = Object.fromEntries(fields[key].filter(field => page.data[field] !== undefined).map(field => [field, copy(page.data[field])]))
  if (key === 'doctor-review') value.submissionDecisions = (page.data.submissions || []).map(row => ({
    submission_id: row.submission_id, decision: row.decision, reason: row.reason }))
  return value
}
function stamp(page, key) {
  const d = page.data
  if (d.pendingId || d.pendingCycleId || d.selectedDraft || d.selectedReport) return null
  if (key === 'care-cycles') return d.cycle ? canonical({ id: d.cycle.id, status: d.cycle.status,
    revision: d.cycle.revision, actions: d.cycle.allowed_actions, plan: d.cycle.plan_version_id,
    records: (d.records || []).map(row => [row.record_date, row.revision, row.payload_digest]), recordDate: d.recordDate,
    canRecord: d.canRecord }) : canonical({ patientId: d.patientId, today: d.today })
  if (key === 'assessments') return d.canCreate ? canonical({ patientId: d.patientId, templateId: d.selectedTemplateId,
    templates: d.templates, backgroundAllowed: d.backgroundProcessingAllowed,
    assessment: d.assessment ? [d.assessment.id, d.assessment.version, d.assessment.status] : null }) : null
  const ctx = key === 'shared-messages' ? page._relation : key === 'review-questions' && d.role === 'patient' ? page._reply : page._context
  if (!ctx) return null
  const bindings = Object.fromEntries(Object.entries(ctx).filter(([name, value]) =>
    name.endsWith('_digest') && typeof value === 'string' || ['revision', 'version', 'assessment_version', 'source_report_id'].includes(name)))
  if (!Object.keys(bindings).length) return null
  return canonical(bindings)
}
function dirty(page, state) { return state.baseline != null && canonical(form(page, state.key)) !== state.baseline }
function arm(page, state) {
  const value = current(page, state) && page._active !== false && dirty(page, state)
  if (state.alert === value) return
  state.alert = value
  const method = value ? 'enableAlertBeforeUnload' : 'disableAlertBeforeUnload'
  try { if (typeof wx[method] === 'function') wx[method]({ message: '填写内容尚未保存，离开前请核对。' }) } catch (_) { /* Older runtimes still keep the assistant return guard. */ }
}
function baseline(page, state) {
  if (current(page, state) && page._active !== false) { state.baseline = canonical(form(page, state.key)); arm(page, state) }
}
function finishRead(page, state, value) {
  if (value && typeof value.then === 'function') return value.then(result => { if (result !== false) baseline(page, state); return result })
  if (value !== false) baseline(page, state)
  return value
}
function discardPrompt(page, state, run) {
  if (state.restoring || !dirty(page, state)) return run()
  if (typeof wx.showModal !== 'function') return false
  return new Promise(resolve => wx.showModal({ title: '这页还有未保存的内容',
    content: '继续切换会重新读取所选资料。可以先留在本页完成保存。', confirmText: '放弃并切换', cancelText: '留在本页',
    success: result => resolve(result.confirm === true && current(page, state)), fail: () => resolve(false)
  })).then(confirmed => confirmed ? run() : false)
}
async function reselect(page, state, selected) {
  const key = state.key
  if (key === 'care-cycles' && selected.cycleId) {
    if (!await page.openCycle({ currentTarget: { dataset: { id: selected.cycleId } } })) return false
    if (selected.recordDate && !page.selectRecordDate({ detail: { value: selected.recordDate } })) return false
  }
  if (key === 'review-questions' && selected.questionId && !await page.selectQuestion({ currentTarget: { dataset: { id: selected.questionId } } })) return false
  if (key === 'imaging-reports' && selected.reportId && !await page.review({ currentTarget: { dataset: { id: selected.reportId } } })) return false
  if (key === 'assessments') {
    if (selected.templateId) page.selectTemplate({ currentTarget: { dataset: { id: selected.templateId } } })
    if (selected.assessmentId && !await page.openAssessment({ currentTarget: { dataset: { id: selected.assessmentId } } })) return false
  }
  return true
}
async function restore(page, state, result) {
  const saved = state.pending
  if (!saved || saved.phase !== 'hidden') return result
  state.pending = null
  if (result === false || !current(page, state) || Date.now() - saved.at > LIMIT) return result
  state.restoring = true
  try {
    if (!await reselect(page, state, saved.selection) || states.get(page) !== state || !current(page, state) || page._active === false) return result
    if (canonical(selection(page)) !== canonical(saved.selection) || stamp(page, state.key) !== saved.stamp) {
      page.setData({ statusText: '材料、版本或权限已有变化，未自动套用之前的输入，请重新核对。' }); return result
    }
    const patch = { ...saved.form }
    if (patch.submissionDecisions) {
      patch.submissions = (page.data.submissions || []).map(row => ({ ...row,
        ...patch.submissionDecisions.find(value => value.submission_id === row.submission_id) }))
      delete patch.submissionDecisions
    }
    if (Object.keys(patch).length) page.setData({ ...patch, statusText: '已恢复打开星仔前未保存的内容，仍需你确认保存。' })
    if (state.key === 'cycle-review' && typeof page.selectDecision === 'function') page.selectDecision({ detail: { value: String(page.data.decisionIndex) } })
    arm(page, state)
    return result
  } finally { state.restoring = false }
}
function clearAssistantDrafts() {
  pages.forEach(page => { states.delete(page) }); pages.clear()
}
function protectAssistantDraft(definition) {
  const key = definition.assistantDraftKey
  if (!fields[key]) return definition
  const wrapped = { ...definition }
  const ensure = page => {
    let state = states.get(page)
    if (!state) { state = { key, owner: owner(), lease: require('./session-privacy').capturePatientSessionLease(), baseline: null, pending: null }
      states.set(page, state); pages.add(page) }
    return state
  }
  wrapped.prepareAssistantNavigation = function () {
    const state = ensure(this)
    if (!current(this, state) || this._active === false || this.data.loading || this.data.busy) return false
    const digest = stamp(this, key)
    if (dirty(this, state) && !digest) { wx.showToast?.({ title: '当前内容暂不能安全恢复，请先保存或留在本页查看帮助', icon: 'none' }); return false }
    state.pending = digest ? { phase: 'prepared', at: Date.now(), selection: selection(this), stamp: digest,
      form: dirty(this, state) ? form(this, key) : {} } : null
    return true
  }
  wrapped.cancelAssistantNavigation = function () { const state = states.get(this); if (state) state.pending = null }
  wrapped.applyAssistantInput = function (patch) {
    const state = ensure(this)
    if (!current(this, state) || this._active === false || this.data.busy || this.data.loading || this.data.pendingId) return false
    state.baseline = canonical(form(this, key))
    this.setData(Object.fromEntries(Object.entries(patch).filter(([field]) => fields[key].includes(field) || field === 'statusText')))
    arm(this, state)
    return true
  }
  if (typeof definition.reload === 'function') wrapped.reload = function (...args) {
    const state = ensure(this), run = () => finishRead(this, state, definition.reload.apply(this, args))
    return args[0]?.currentTarget ? discardPrompt(this, state, run) : run()
  }
  for (const name of readMethods[key] || []) if (typeof definition[name] === 'function') wrapped[name] = function (...args) {
    const state = ensure(this)
    const event = args[0], id = event?.currentTarget?.dataset?.id, index = Number(event?.detail?.value)
    const changed = name === 'openCycle' ? Number(id) !== this.data.cycle?.id
      : name === 'selectRecordDate' ? event?.detail?.value !== this.data.recordDate
        : name === 'selectQuestion' ? Number(id) !== this.data.selectedQuestion?.id
          : name === 'review' ? Number(id) !== this.data.selected?.id
            : name === 'selectTemplate' ? id !== this.data.selectedTemplateId
              : name === 'selectPatient' ? index !== this.data.patientIndex : index !== this.data.relationshipIndex
    const run = () => finishRead(this, state, definition[name].apply(this, args))
    // Internal refresh of the just-accepted original must never prompt or block.
    return changed || event?.type ? discardPrompt(this, state, run) : run()
  }
  for (const name of Object.keys(definition).filter(name => /^on[A-Z]/.test(name) && !['onLoad','onShow','onHide','onUnload','onPatientSessionEnded'].includes(name))) {
    if (typeof definition[name] !== 'function') continue
    wrapped[name] = function (...args) { const result = definition[name].apply(this, args); arm(this, ensure(this)); return result }
  }
  wrapped.onLoad = function (...args) { ensure(this); return definition.onLoad?.apply(this, args) }
  wrapped.onShow = function (...args) {
    const state = ensure(this), result = definition.onShow?.apply(this, args)
    return result && typeof result.then === 'function' ? result.then(value => restore(this, state, value)) : restore(this, state, result)
  }
  wrapped.onHide = function (...args) {
    const state = states.get(this)
    if (state) { state.baseline = null; if (state.pending?.phase === 'prepared' && current(this, state)) state.pending.phase = 'hidden'; else state.pending = null }
    return definition.onHide?.apply(this, args)
  }
  for (const name of ['onUnload', 'onPatientSessionEnded']) wrapped[name] = function (...args) {
    states.delete(this); pages.delete(this)
    if (typeof definition[name] === 'function') return definition[name].apply(this, args)
    if (name === 'onPatientSessionEnded') this._ended = true
    return definition.onHide?.apply(this, args)
  }
  return wrapped
}
module.exports = { protectAssistantDraft, clearAssistantDrafts }
