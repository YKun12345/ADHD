const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const token = () => 'service-coverage-context.v1.' + Buffer.from(JSON.stringify({ purpose: 'service_coverage', actor_user_id: 7,
  doctor_user_id: 90, institution_id: 'synthetic-institution', expected_previous_version: 0, credential_snapshot: [] })).toString('base64url') + '.' + 'a'.repeat(64)
const settings = { timezone: 'Asia/Shanghai', working_periods: [{ weekday: 0, start: '09:00', end: '12:00' }],
  expected_response_working_minutes: 60, approved_process_reference: 'synthetic-existing-reference', escalation_instructions: '合成机构现实流程原文' }
const body = id => ({ client_coverage_id: id, expected_previous_version: 0, doctor_user_id: 90, institution_id: 'synthetic-institution',
  ...settings, configuration_context: token() })
const ack = payload => ({ ...settings, id: 11, client_coverage_id: payload.client_coverage_id, doctor_user_id: 90, reviewer_user_id: 7,
  institution_id: 'synthetic-institution', version: 1, effective_from: '2026-10-16T01:00:00+00:00', payload_digest: 'a'.repeat(64),
  configuration_context_digest: 'd'.repeat(64), submission_status: 'committed', legacy: false, institutional_admission_status: 'not_verified_by_configuration' })
function arrange(h, { lost = false } = {}) {
  let saved
  h.storage.current_user.role = 'researcher'
  wx.showModal = options => options.success({ confirm: true })
  h.setRequest(async options => {
    if (options.url === '/identity/service-coverage/doctors') return { items: [{ doctor_user_id: 90, institution_id: 'synthetic-institution' }] }
    if (options.url.startsWith('/identity/service-coverage/90/versions')) return { items: saved ? [saved] : [], configuration_context: token(), configuration_context_digest: 'd'.repeat(64) }
    if (options.url === '/identity/service-coverage-versions') {
      saved = ack(options.data)
      if (lost) throw new Error('synthetic lost ACK')
      return saved
    }
    if (options.url.startsWith('/identity/service-coverage-submissions/')) return saved
    throw new Error('unexpected ' + options.url)
  })
}

test('coverage queue has real institution scope without a fake patient and rejects contradictory ACK metadata', async () => {
  const h = createHarness()
  try {
    arrange(h)
    const q = require('../utils/submission-queue')
    q.enqueue({ id: 'coverage-original', kind: 'service_coverage', route: '/identity/service-coverage-versions', expected_context_digest: 'd'.repeat(64), payload: body('coverage-original') })
    assert.equal(require('../utils/session-privacy').summarizePatientData().pendingCount, 1)
    h.setRequest(async () => ({ ...ack(body('coverage-original')), reviewer_user_id: 99 }))
    assert.equal(await q.syncQueued('coverage-original'), false)
    assert.equal(q.pendingEntries()[0].payload.patient_id, undefined)
    assert.equal(q.pendingEntries()[0].status, 'ack_unverified')
    h.setRequest(async options => { assert.equal(options.url, '/identity/service-coverage-submissions/coverage-original'); return ack(body('coverage-original')) })
    assert.equal(await q.queryQueuedStatus('coverage-original'), true)
    assert.deepEqual(q.pendingEntries(), [])
  } finally { h.restore() }
})

test('only server-listed reviewer scope exposes configuration and an explicitly confirmed version is saved through the real queue', async () => {
  const h = createHarness()
  try {
    arrange(h)
    const page = h.load('service-coverage'); await page._loadPromise
    assert.equal(page.data.canConfigure, true)
    assert.equal(page.data.doctorId, 0)
    assert.equal(await page.selectDoctor({ detail: { value: '0' } }), true)
    for (const [field, value] of Object.entries({ periodsText: '周一 09:00-12:00', responseMinutes: '60', processReference: settings.approved_process_reference, instructions: settings.escalation_instructions })) {
      page.onFieldInput({ currentTarget: { dataset: { field } }, detail: { value } })
    }
    assert.equal(await page.saveVersion(), true, page.data.errorText)
    assert.equal(page.data.history.length, 1)
    assert.match(page.data.statusText, /服务器已确认/)
    assert.equal(h.requests.filter(value => value.method === 'POST').length, 1)
    assert.ok(h.writes.some(([key, value]) => key === 'submission_queue_v1' && value.entries.length === 1))
  } finally { h.restore() }
})

test('lost config ACK retains original institutional token and reload only queries its ID', async () => {
  const h = createHarness()
  try {
    arrange(h, { lost: true })
    const page = h.load('service-coverage'); await page._loadPromise; await page.selectDoctor({ detail: { value: '0' } })
    for (const [field, value] of Object.entries({ periodsText: '周一 09:00-12:00', responseMinutes: '60', processReference: settings.approved_process_reference, instructions: settings.escalation_instructions })) page.onFieldInput({ currentTarget: { dataset: { field } }, detail: { value } })
    assert.equal(await page.saveVersion(), false)
    const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
    page.onHide(); assert.deepEqual(page.data.history, []); await page.onShow(); await page.selectDoctor({ detail: { value: '0' } })
    assert.equal(page.data.pendingId, original.id)
    assert.equal(await page.queryPending(), true)
    assert.equal(h.requests.filter(value => value.method === 'POST').length, 1)
    assert.deepEqual(q.pendingEntries(), [])
  } finally { h.restore() }
})

test('ordinary qualified doctor sees only their actual coverage, and a hidden old page cannot revive under another account', async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    h.setRequest(async options => {
      if (options.url.endsWith('/doctors')) throw Object.assign(new Error('no institutional reviewer scope'), { statusCode: 403 })
      return { status: 'not_configured', coverage: null }
    })
    const page = h.load('service-coverage'); await page._loadPromise
    assert.equal(page.data.canConfigure, false); assert.match(page.data.currentText, /未配置/)
    assert.equal(await page.saveVersion(), false)
    page.onHide()
    require('../utils/session-privacy').replacePatientSession({ access_token: 'other', user: { id: 9, role: 'researcher' } })
    assert.equal(await page.onShow(), false)
    assert.deepEqual(page.data.history, [])
  } finally { h.restore() }
})

test('coverage originals survive mismatched versions, institution, clock, work periods or context ACK and actual B replacement', async () => {
  const h = createHarness()
  try {
    arrange(h)
    const q = require('../utils/submission-queue'), original = body('all-fields-original')
    q.enqueue({ id: original.client_coverage_id, kind: 'service_coverage', route: '/identity/service-coverage-versions', expected_context_digest: 'd'.repeat(64), payload: original })
    for (const variation of [{ version: 2 }, { doctor_user_id: 99 }, { institution_id: 'another' }, { configuration_context_digest: 'e'.repeat(64) },
      { effective_from: 'unknown' }, { working_periods: [] }, { expected_response_working_minutes: 2 }, { escalation_instructions: 'changed' }, { legacy: true }, { submission_status: 'pending' }]) {
      h.setRequest(async () => ({ ...ack(original), ...variation }))
      assert.equal(await q.syncQueued(original.client_coverage_id), false, JSON.stringify(variation))
      assert.deepEqual(q.pendingEntries()[0].payload, original)
    }
    let finish
    h.setRequest(() => new Promise(resolve => { finish = () => resolve(ack(original)) }))
    const late = q.syncQueued(original.client_coverage_id); await Promise.resolve()
    require('../utils/session-privacy').replacePatientSession({ access_token: 'actual-B', user: { id: 9, role: 'researcher' } })
    finish(); assert.equal(await late, false)
    assert.equal(h.storage.current_user.id, 9)
  } finally { h.restore() }
})
