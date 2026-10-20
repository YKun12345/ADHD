const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const reject = statusCode => Object.assign(new Error('synthetic result'), { statusCode })
const digest = 'd'.repeat(64), stamp = '2026-10-16T05:00:00+00:00'
const token = (prefix, value) => `${prefix}.v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${'a'.repeat(64)}`
const tap = action => ({ currentTarget: { dataset: { id: 11, action } } })
const settings = { timezone: 'Asia/Shanghai', working_periods: [{ weekday: 0, start: '09:00', end: '12:00' }],
  expected_response_working_minutes: 60, approved_process_reference: 'synthetic-approved-process', escalation_instructions: '合成现实处理说明' }
function arrange(h, coverage) {
  const state = { advanced: false, posts: [], modals: [], ready: false }
  if (coverage) h.storage.current_user.role = 'researcher'
  wx.showModal = options => { state.modals.push(options); options.success({ confirm: true }) }
  const row = () => ({ id: 11, patient_id: 8, assessment_id: 42, kind: 'assessment_quality', owner_kind: 'patient_self',
    responsible_doctor_id: null, status: state.advanced ? 'acknowledged' : 'open', version: state.advanced ? 2 : 1,
    quality_reasons: [], response_coverage: { status: 'not_configured' }, allowed_actions: ['view_assessment'] })
  const ctx = () => coverage ? token('service-coverage-context', { purpose: 'service_coverage', actor_user_id: 7,
    doctor_user_id: 90, institution_id: 'synthetic-institution', expected_previous_version: state.advanced ? 1 : 0, credential_snapshot: [] })
    : token('attention-action-context', { purpose: 'attention_action', version: 1, actor_user_id: 7,
      actor_identity_basis: 'self:7:access:1:revision:1', patient_id: 8, attention_id: 11,
      expected_version: state.advanced ? 2 : 1, previous_status: state.advanced ? 'acknowledged' : 'open', authorization_snapshot: [] })
  h.setRequest(async options => {
    if (options.url === '/identity/service-coverage/doctors') return { items: [{ doctor_user_id: 90, institution_id: 'synthetic-institution' }] }
    if (options.url.startsWith('/identity/service-coverage/90/versions')) return { configuration_context: ctx(), configuration_context_digest: digest,
      items: state.advanced ? [{ ...settings, id: 11, doctor_user_id: 90, institution_id: 'synthetic-institution', version: 1,
        effective_from: stamp, submission_status: 'committed', legacy: false }] : [] }
    if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 8 }] }
    if (options.url === '/care/patient/attention?patient_id=8') return { items: [row()] }
    if (options.url === '/care/attention/11') return { attention: row(), action_context: ctx(), action_context_digest: digest,
      allowed_actions: state.advanced ? ['resolve', 'close_with_reason'] : ['acknowledge', 'close_with_reason'] }
    if (options.url === '/care/attention/11/history') return { items: [] }
    if (options.method === 'POST') { state.posts.push(options.data); state.advanced = true; throw reject(409) }
    if (options.url.startsWith('/identity/service-coverage-submissions/') || options.url.startsWith('/care/attention-actions/')) throw reject(404)
    throw new Error('Unexpected ' + options.url)
  })
  return state
}
async function blocked(h, coverage) {
  const state = arrange(h, coverage), page = h.load(coverage ? 'service-coverage' : 'care-attention')
  await page._loadPromise
  if (coverage) {
    await page.selectDoctor({ detail: { value: '0' } })
    for (const [field, value] of Object.entries({ periodsText: '周一 09:00-12:00', responseMinutes: '60',
      processReference: settings.approved_process_reference, instructions: settings.escalation_instructions })) {
      page.onFieldInput({ currentTarget: { dataset: { field } }, detail: { value } })
    }
    assert.equal(await page.saveVersion(), false); assert.equal(await page.queryPending(), false)
  } else {
    await page.openProcessing(tap()); assert.equal(await page.submitAction(tap('acknowledge')), false)
    assert.equal(await page.queryAction(), false)
  }
  const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
  return { state, page, q, original }
}
for (const coverage of [false, true]) {
  const name = coverage ? 'service_coverage' : 'attention_action'
  test(`${name} explicit archive keeps original, gets fresh authority and requires a new confirmation before any new POST`, async () => {
    const h = createHarness()
    try {
      const { state, page, q, original } = await blocked(h, coverage)
      assert.equal(original.status, 'conflict_blocked'); assert.equal(page.data.canArchivePending, true)
      assert.equal(await page.archivePending(), true)
      assert.deepEqual(q.allEntries()[0].payload, original.payload); assert.equal(q.allEntries()[0].fingerprint, original.fingerprint)
      assert.equal(q.pendingEntries().length, 0); assert.equal(state.posts.length, 1)
      assert.equal(require('../utils/session-privacy').summarizePatientData().pendingCount, 1)
      assert.match(state.modals.at(-1).content, /原件.*保留/); assert.match(state.modals.at(-1).content, /不表示.*撤销/)
      assert.equal(coverage ? page.data.doctorId : page.data.processing, coverage ? 0 : null)
      if (coverage) {
        await page.selectDoctor({ detail: { value: '0' } })
        page.onFieldInput({ currentTarget: { dataset: { field: 'responseMinutes' } }, detail: { value: '120' } })
        h.advance(1); await page.saveVersion()
        assert.equal(state.posts[1].expected_previous_version, 1)
        assert.equal(state.posts[1].expected_response_working_minutes, 120)
        assert.notEqual(state.posts[1].configuration_context, original.payload.configuration_context)
        assert.notEqual(state.posts[1].client_coverage_id, original.id)
      } else {
        await page.openProcessing(tap()); assert.equal(page.data.processing.canResolve, true)
        page.onReasonInput({ detail: { value: '实际当前处理说明' } })
        h.advance(1); await page.submitAction(tap('resolve'))
        assert.equal(state.posts[1].expected_version, 2); assert.equal(state.posts[1].action, 'resolve')
        assert.notEqual(state.posts[1].action_context, original.payload.action_context)
        assert.notEqual(state.posts[1].client_action_id, original.id)
      }
      assert.equal(state.modals.length, 3); assert.equal(state.posts.length, 2)
      const recovery = h.load('submission-queue')
      assert.equal(recovery.data.entries[0].canRetry, false)
      assert.equal(recovery.viewOriginal({ currentTarget: { dataset: { id: original.id } } }), true)
      assert.match(recovery.data.originalText, new RegExp(coverage ? 'configuration_context' : 'action_context'))
      assert.equal(await recovery.retry({ currentTarget: { dataset: { id: original.id } } }), false)
      assert.equal(state.posts.length, 2)
    } finally { h.restore() }
  })
  test(`${name} unknown POST, mismatched query, cancel, hidden modal and storage failure cannot retire a current original`, async () => {
    const h = createHarness()
    try {
      const { page, q, original } = await blocked(h, coverage)
      wx.showModal = options => options.success({ confirm: false })
      assert.equal(await page.archivePending(), false)
      let finish; wx.showModal = options => { finish = () => options.success({ confirm: true }) }
      const pending = page.archivePending(); await h.flush(); page.onHide(); await page.onShow(); finish()
      assert.equal(await pending, false); assert.equal(q.pendingEntries()[0].id, original.id)
      const recovery = h.load('submission-queue'), oldSet = wx.setStorageSync
      wx.showModal = options => options.success({ confirm: true }); wx.setStorageSync = () => { throw new Error('synthetic storage full') }
      assert.equal(await recovery.archive({ currentTarget: { dataset: { id: original.id } } }), false)
      wx.setStorageSync = oldSet; assert.equal(q.pendingEntries()[0].id, original.id)
      h.setRequest(async () => ({ id: 999, submission_status: 'committed' })); await q.queryQueuedStatus(original.id)
      assert.equal(q.pendingEntries()[0].status, 'conflict_blocked'); assert.equal(q.canArchive(q.pendingEntries()[0]), false)
      h.setRequest(async () => { throw reject(404) }); await q.queryQueuedStatus(original.id)
      assert.equal(q.canArchive(q.pendingEntries()[0]), true)
      h.setRequest(async () => { throw new Error('POST might have committed') }); await q.syncQueued(original.id)
      h.setRequest(async () => { throw reject(404) }); await q.queryQueuedStatus(original.id)
      assert.equal(q.canArchive(q.pendingEntries()[0]), false)
      assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
    } finally { h.restore() }
  })
}
