const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const tap = id => ({ currentTarget: { dataset: { id } } })
const failure = statusCode => Object.assign(new Error('independent synthetic response'), { statusCode })
const digest = 'd'.repeat(64), stamp = '2026-10-16T05:00:00+00:00'
const token = (prefix, value) => `${prefix}.v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${'a'.repeat(64)}`
const kinds = ['attention_action', 'service_coverage']
const settings = { timezone: 'Asia/Shanghai', working_periods: [{ weekday: 0, start: '09:00', end: '12:00' }],
  expected_response_working_minutes: 60, approved_process_reference: 'independent-approved-reference', escalation_instructions: 'independent-supplied-process' }
function entry(kind, id, contextSuffix = 'old') {
  const coverage = kind === 'service_coverage'
  const context = coverage ? { purpose: 'service_coverage', actor_user_id: 7, doctor_user_id: 90,
    institution_id: 'synthetic-institution', expected_previous_version: 0, credential_snapshot: [contextSuffix] }
    : { purpose: 'attention_action', version: 1, actor_user_id: 7, actor_identity_basis: 'independent-self',
      patient_id: 8, attention_id: 11, expected_version: 1, previous_status: 'open', authorization_snapshot: [[contextSuffix]] }
  return { id, kind, expected_context_digest: digest, route: coverage ? '/identity/service-coverage-versions' : '/care/attention-actions',
    payload: coverage ? { client_coverage_id: id, doctor_user_id: 90, institution_id: 'synthetic-institution', expected_previous_version: 0,
      ...settings, configuration_context: token('service-coverage-context', context) }
      : { client_action_id: id, attention_id: 11, patient_id: 8, expected_version: 1, action: 'acknowledge', reason: null,
        action_context: token('attention-action-context', context), confirmed: true } }
}
function acknowledgement(original) {
  const p = original.payload
  return original.kind === 'service_coverage' ? { ...settings, id: 31, client_coverage_id: original.id, doctor_user_id: 90,
    institution_id: 'synthetic-institution', reviewer_user_id: 7, version: 1, effective_from: stamp,
    configuration_context_digest: digest, payload_digest: 'e'.repeat(64), submission_status: 'committed', legacy: false }
    : { action_id: 41, ...p, actor_user_id: 7, actor_identity_basis: 'independent-self', previous_status: 'open', status: 'acknowledged',
      version: 2, occurred_at: stamp, action_context_digest: digest, authorization_snapshot: [['old']], submission_status: 'committed', legacy: false }
}
async function rejectAndQuery(h, q, id, code = 409) {
  h.setRequest(async () => { throw failure(code) }); assert.equal(await q.syncQueued(id), false)
  h.setRequest(async () => { throw failure(404) }); assert.equal(await q.queryQueuedStatus(id), false)
}

for (const kind of kinds) test(`independent repair acceptance: ${kind} recovery archive retains original, permits only a newly confirmed original and stays query-only`, async () => {
  const h = createHarness()
  try {
    if (kind === 'service_coverage') h.storage.current_user.role = 'researcher'
    const q = require('../utils/submission-queue'), original = entry(kind, 'independent-original')
    q.enqueue(original); await rejectAndQuery(h, q, original.id)
    const before = q.allEntries()[0], page = h.load('submission-queue')
    assert.equal(page.data.entries[0].canArchive, true)
    assert.equal(page.viewOriginal(tap(original.id)), true)
    assert.deepEqual(JSON.parse(page.data.originalText).payload, original.payload)
    wx.showModal = options => options.success({ confirm: true })
    assert.equal(await page.archive(tap(original.id)), true)
    assert.equal(q.pendingEntries().length, 0)
    assert.deepEqual(q.allEntries()[0].payload, original.payload)
    assert.equal(q.allEntries()[0].fingerprint, before.fingerprint)
    assert.equal(require('../utils/session-privacy').summarizePatientData().pendingCount, 1)
    // Same source/version under a fresh explicit context is a new original; old
    // archived authority and ID cannot be changed or automatically resent.
    const fresh = entry(kind, 'independent-fresh', 'fresh-authority')
    q.enqueue(fresh)
    let posts = 0
    h.setRequest(async options => { if (options.method === 'POST') posts++; return { ...acknowledgement(original),
      ...(kind === 'service_coverage' ? { reviewer_user_id: 999 } : { actor_user_id: 999 }) } })
    assert.equal(await page.retry(tap(original.id)), false)
    assert.equal(await page.queryStatus(tap(original.id)), false)
    assert.equal(q.allEntries().length, 2)
    h.setRequest(async options => { assert.equal(options.method || 'GET', 'GET'); return acknowledgement(original) })
    assert.equal(await page.queryStatus(tap(original.id)), true)
    assert.deepEqual(q.allEntries().map(item => item.id), [fresh.id])
    assert.equal(posts, 0)
  } finally { h.restore() }
})

for (const kind of kinds) test(`independent repair safety: ${kind} unknown/retried outcomes, storage failure and late recovery modal never retire an active original`, async () => {
  const h = createHarness()
  try {
    if (kind === 'service_coverage') h.storage.current_user.role = 'researcher'
    const q = require('../utils/submission-queue'), original = entry(kind, 'independent-safe-original')
    q.enqueue(original)
    h.setRequest(async () => { throw failure(404) }); await q.queryQueuedStatus(original.id)
    assert.equal(q.archiveQueued(original.id, { confirmed: true }), false)
    await rejectAndQuery(h, q, original.id, 403)
    assert.equal(q.archiveQueued(original.id), false)
    const save = wx.setStorageSync; wx.setStorageSync = () => { throw new Error('independent storage failure') }
    assert.throws(() => q.archiveQueued(original.id, { confirmed: true }))
    wx.setStorageSync = save
    assert.equal(q.pendingEntries().length, 1)
    h.setRequest(async () => { throw new Error('unknown commit after retry') }); await q.syncQueued(original.id)
    h.setRequest(async () => { throw failure(404) }); await q.queryQueuedStatus(original.id)
    assert.equal(q.canArchive(q.pendingEntries()[0]), false)
    await rejectAndQuery(h, q, original.id)
    const page = h.load('submission-queue')
    let complete
    wx.showModal = options => { complete = () => options.success({ confirm: true }) }
    const pending = page.archive(tap(original.id)); await h.flush()
    page.onHide(); page.onShow(); complete()
    assert.equal(await pending, false)
    assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
    const waiting = page.archive(tap(original.id)); await h.flush()
    require('../utils/session-privacy').replacePatientSession({ access_token: 'new-account', user: { id: 9,
      role: kind === 'service_coverage' ? 'researcher' : 'patient' } })
    complete(); assert.equal(await waiting, false)
    assert.equal(page.viewOriginal(tap(original.id)), false)
  } finally { h.restore() }
})

test('independent actual coverage archivePending clears old selection and requires current version, fresh context, fields and real confirmation', async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    let concurrent = false, savedNew = null
    const posts = [], modals = []
    const ctx = () => token('service-coverage-context', { purpose: 'service_coverage', actor_user_id: 7, doctor_user_id: 90,
      institution_id: 'synthetic-institution', expected_previous_version: savedNew ? 2 : concurrent ? 1 : 0, credential_snapshot: [] })
    wx.showModal = options => { modals.push(options); options.success({ confirm: true }) }
    h.setRequest(async options => {
      if (options.url.endsWith('/doctors')) return { items: [{ doctor_user_id: 90, institution_id: 'synthetic-institution' }] }
      if (options.url.startsWith('/identity/service-coverage/90/versions')) return { configuration_context: ctx(), configuration_context_digest: digest,
        items: concurrent ? [{ id: 11, ...settings, doctor_user_id: 90, institution_id: 'synthetic-institution', version: 1,
          effective_from: stamp, submission_status: 'committed', legacy: false }, ...(savedNew ? [savedNew] : [])] : [] }
      if (options.url.startsWith('/identity/service-coverage-submissions/')) throw failure(404)
      if (options.method === 'POST') {
        posts.push(options.data)
        if (posts.length === 1) { concurrent = true; throw failure(409) }
        const p = options.data
        savedNew = { id: 12, ...p, reviewer_user_id: 7, version: p.expected_previous_version + 1, effective_from: stamp,
          configuration_context_digest: digest, payload_digest: 'e'.repeat(64), submission_status: 'committed', legacy: false }
        return savedNew
      }
      throw new Error('unexpected ' + options.url)
    })
    const page = h.load('service-coverage'); await page._loadPromise; await page.selectDoctor({ detail: { value: '0' } })
    for (const [field, value] of Object.entries({ periodsText: '周一 09:00-12:00', responseMinutes: '60',
      processReference: settings.approved_process_reference, instructions: settings.escalation_instructions })) {
      page.onFieldInput({ currentTarget: { dataset: { field } }, detail: { value } })
    }
    assert.equal(await page.saveVersion(), false)
    const q = require('../utils/submission-queue'), before = q.pendingEntries()[0]
    assert.equal(await page.queryPending(), false)
    assert.equal(page.data.canArchivePending, true)
    assert.equal(await page.archivePending(), true)
    assert.equal(page.data.doctorId, 0)
    assert.equal(page._original, null)
    assert.equal(await page.saveVersion(), false)
    assert.equal(await page.selectDoctor({ detail: { value: '0' } }), true)
    assert.equal(page._original.previous, 1)
    page.onFieldInput({ currentTarget: { dataset: { field: 'responseMinutes' } }, detail: { value: '120' } })
    h.advance(1)
    assert.equal(await page.saveVersion(), true, page.data.errorText)
    assert.equal(posts.length, 2)
    assert.equal(posts[1].expected_previous_version, 1)
    assert.equal(posts[1].expected_response_working_minutes, 120)
    assert.notEqual(posts[1].client_coverage_id, before.id)
    assert.notEqual(posts[1].configuration_context, before.payload.configuration_context)
    assert.equal(modals.length, 3)
    assert.match(modals[1].content, /不表示已撤销服务器请求/)
    assert.equal(q.pendingEntries().length, 0)
    assert.deepEqual(q.allEntries()[0].payload, before.payload)
  } finally { h.restore() }
})

test('independent actual attention archivePending clears stale processing, then rereads and confirms current next action with actual reason', async () => {
  const h = createHarness()
  try {
    let status = 'open', saved = null
    const posts = [], modals = []
    const row = () => ({ id: 11, patient_id: 8, assessment_id: 42, submission_id: null, kind: 'assessment_quality', owner_kind: 'patient_self',
      responsible_doctor_id: null, status, version: status === 'open' ? 1 : status === 'acknowledged' ? 2 : 3,
      quality_reasons: [], response_coverage: { status: 'not_configured' }, allowed_actions: ['view_assessment'] })
    wx.showModal = options => { modals.push(options); options.success({ confirm: true }) }
    h.setRequest(async options => {
      if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 8 }] }
      if (options.url === '/care/patient/attention?patient_id=8') return { items: [row()] }
      if (options.url === '/care/attention/11') return { attention: row(), allowed_actions: status === 'resolved' ? [] :
        status === 'open' ? ['acknowledge', 'close_with_reason'] : ['resolve', 'close_with_reason'],
        action_context_digest: status === 'resolved' ? null : digest,
        action_context: status === 'resolved' ? null : token('attention-action-context', { purpose: 'attention_action', version: 1,
          actor_user_id: 7, actor_identity_basis: 'independent-self', patient_id: 8, attention_id: 11, expected_version: row().version,
          previous_status: status, authorization_snapshot: [] }) }
      if (options.url === '/care/attention/11/history') return { items: saved ? [saved] : [] }
      if (options.url.startsWith('/care/attention-actions/')) throw failure(404)
      if (options.url === '/care/attention-actions' && options.method === 'POST') {
        posts.push(options.data)
        if (posts.length === 1) { status = 'acknowledged'; throw failure(409) }
        status = 'resolved'
        saved = { action_id: 31, ...options.data, actor_user_id: 7, actor_identity_basis: 'independent-self', previous_status: 'acknowledged',
          status: 'resolved', version: 3, occurred_at: stamp, action_context_digest: digest, authorization_snapshot: [], submission_status: 'committed', legacy: false }
        return saved
      }
      throw new Error('unexpected ' + options.url)
    })
    const page = h.load('care-attention'); await page._loadPromise; await page.openProcessing(tap(11))
    assert.equal(await page.submitAction({ currentTarget: { dataset: { id: 11, action: 'acknowledge' } } }), false)
    const q = require('../utils/submission-queue'), before = q.pendingEntries()[0]
    assert.equal(await page.queryAction(), false)
    assert.equal(page.data.canArchivePending, true)
    assert.equal(await page.archivePending(), true)
    assert.equal(page.data.processing, null)
    assert.equal(page._detail, null)
    assert.equal(page.data.processingReason, '')
    assert.equal(await page.submitAction({ currentTarget: { dataset: { id: 11, action: 'resolve' } } }), false)
    assert.equal(await page.openProcessing(tap(11)), true)
    assert.equal(page.data.processing.canResolve, true)
    page.onReasonInput({ detail: { value: 'independent actual resolution explanation' } })
    h.advance(1)
    assert.equal(await page.submitAction({ currentTarget: { dataset: { id: 11, action: 'resolve' } } }), true, page.data.errorText)
    assert.equal(posts.length, 2)
    assert.equal(posts[1].expected_version, 2)
    assert.notEqual(posts[1].client_action_id, before.id)
    assert.notEqual(posts[1].action_context, before.payload.action_context)
    assert.equal(posts[1].reason, 'independent actual resolution explanation')
    assert.equal(modals.length, 3)
    assert.match(modals[1].content, /不表示已撤销服务器请求/)
    assert.deepEqual(q.allEntries()[0].payload, before.payload)
    assert.equal(q.pendingEntries().length, 0)
  } finally { h.restore() }
})
