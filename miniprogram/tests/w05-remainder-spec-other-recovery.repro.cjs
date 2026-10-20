const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const rejection = statusCode => Object.assign(new Error('synthetic known non-creation result'), { statusCode })
const tap = id => ({ currentTarget: { dataset: { id } } })
const token = (prefix, value) => `${prefix}.v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${'a'.repeat(64)}`

test('independent reproduction: rejected coverage version cannot be retired to confirm a current newer institutional version', async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    const settings = { timezone: 'Asia/Shanghai', working_periods: [{ weekday: 0, start: '09:00', end: '12:00' }],
      expected_response_working_minutes: 60, approved_process_reference: 'independent-institution-reference', escalation_instructions: 'independent supplied process' }
    let otherVersion = false, posts = 0
    const ctx = () => token('service-coverage-context', { purpose: 'service_coverage', actor_user_id: 7,
      doctor_user_id: 90, institution_id: 'synthetic-institution', expected_previous_version: otherVersion ? 1 : 0, credential_snapshot: [] })
    wx.showModal = options => options.success({ confirm: true })
    h.setRequest(async options => {
      if (options.url === '/identity/service-coverage/doctors') return { items: [{ doctor_user_id: 90, institution_id: 'synthetic-institution' }] }
      if (options.url.startsWith('/identity/service-coverage/90/versions')) return { configuration_context: ctx(), configuration_context_digest: 'd'.repeat(64),
        items: otherVersion ? [{ id: 11, ...settings, doctor_user_id: 90, institution_id: 'synthetic-institution', version: 1,
          effective_from: '2026-10-16T05:00:00+00:00', submission_status: 'committed', legacy: false }] : [] }
      if (options.method === 'POST') { posts++; otherVersion = true; throw rejection(409) }
      if (options.url.startsWith('/identity/service-coverage-submissions/')) throw rejection(404)
      throw new Error('unexpected ' + options.url)
    })
    const page = h.load('service-coverage'); await page._loadPromise; await page.selectDoctor({ detail: { value: '0' } })
    for (const [field, value] of Object.entries({ periodsText: '周一 09:00-12:00', responseMinutes: '60',
      processReference: settings.approved_process_reference, instructions: settings.escalation_instructions })) {
      page.onFieldInput({ currentTarget: { dataset: { field } }, detail: { value } })
    }
    assert.equal(await page.saveVersion(), false)
    const q = require('../utils/submission-queue'), before = q.pendingEntries()[0]
    assert.equal(before.status, 'conflict_blocked')
    assert.equal(await page.queryPending(), false)
    page.onHide(); await page.onShow(); await page.selectDoctor({ detail: { value: '0' } })
    assert.equal(page.data.history[0].version, 1)
    assert.equal(page._original.previous, 1)
    assert.equal(page.data.pendingId, before.id)
    page.onFieldInput({ currentTarget: { dataset: { field: 'responseMinutes' } }, detail: { value: '120' } })
    assert.equal(page.data.responseMinutes, '60')
    assert.equal(await page.saveVersion(), false)
    const recovery = h.load('submission-queue')
    assert.equal(recovery.data.entries[0].canArchive, false)
    assert.equal(q.archiveQueued(before.id, { confirmed: true }), false)
    assert.equal(posts, 1)
    assert.deepEqual(q.pendingEntries()[0].payload, before.payload)
    console.log('CONFIRMED REMAINING GAP: service_coverage old POST409 + original-ID404 blocks every new version of the same doctor; current newer version/context cannot be confirmed without bulk clearing.')
  } finally { h.restore() }
})

test('independent reproduction: rejected attention action blocks current next action and has no single-original retirement', async () => {
  const h = createHarness()
  try {
    let advanced = false, posts = 0
    const row = () => ({ id: 11, patient_id: 8, assessment_id: 42, submission_id: null, kind: 'assessment_quality', owner_kind: 'patient_self',
      responsible_doctor_id: null, status: advanced ? 'acknowledged' : 'open', version: advanced ? 2 : 1,
      quality_reasons: [], response_coverage: { status: 'not_configured' }, allowed_actions: ['view_assessment'] })
    h.setRequest(async options => {
      if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 8 }] }
      if (options.url === '/care/patient/attention?patient_id=8') return { items: [row()] }
      if (options.url === '/care/attention/11') return { attention: row(), allowed_actions: advanced ? ['resolve', 'close_with_reason'] : ['acknowledge', 'close_with_reason'],
        action_context_digest: 'd'.repeat(64), action_context: token('attention-action-context', { purpose: 'attention_action', version: 1,
          actor_user_id: 7, actor_identity_basis: 'self:7:access:1:revision:1', patient_id: 8, attention_id: 11,
          expected_version: advanced ? 2 : 1, previous_status: advanced ? 'acknowledged' : 'open', authorization_snapshot: [] }) }
      if (options.url === '/care/attention/11/history') return { items: [] }
      if (options.url === '/care/attention-actions' && options.method === 'POST') { posts++; advanced = true; throw rejection(409) }
      if (options.url.startsWith('/care/attention-actions/')) throw rejection(404)
      throw new Error('unexpected ' + options.url)
    })
    wx.showModal = options => options.success({ confirm: true })
    const page = h.load('care-attention'); await page._loadPromise; await page.openProcessing(tap(11))
    assert.equal(await page.submitAction({ currentTarget: { dataset: { id: 11, action: 'acknowledge' } } }), false)
    const q = require('../utils/submission-queue'), before = q.pendingEntries()[0]
    assert.equal(await page.queryAction(), false)
    page.onHide(); await page.onShow(); await page.openProcessing(tap(11))
    assert.equal(page.data.processing.version, 2)
    assert.deepEqual(page._detail.allowed_actions, ['resolve', 'close_with_reason'])
    assert.equal(page.data.processing.canResolve, false)
    assert.equal(page.data.pendingId, before.id)
    assert.equal(await page.submitAction({ currentTarget: { dataset: { id: 11, action: 'resolve' } } }), false)
    const recovery = h.load('submission-queue')
    assert.equal(recovery.data.entries[0].canArchive, false)
    assert.equal(q.archiveQueued(before.id, { confirmed: true }), false)
    assert.equal(posts, 1)
    assert.deepEqual(q.pendingEntries()[0].payload, before.payload)
    console.log('CONFIRMED REMAINING GAP: attention_action old POST409 + original-ID404 blocks a legal current next action; only global privacy clearing is exposed.')
  } finally { h.restore() }
})
