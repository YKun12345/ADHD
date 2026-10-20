const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const stamp = '2026-10-16T04:00:00+00:00', digest = 'd'.repeat(64)
const source = id => ({ source_type: 'attention', source_id: id, expected_version: 1, from_doctor_user_id: 80 })
function entry(id, sourceId = 12) {
  const sources = [source(sourceId)], selected = sources.map(({ from_doctor_user_id, ...row }) => row)
  const value = { purpose: 'care_transfer_request', context_version: 1, actor_user_id: 7, actor_identity_basis: 'original-basis',
    patient_id: 19, authorization_snapshot: [['original-synthetic-receipt']], receiving_relationship_id: 20,
    receiver_doctor_user_id: 90, selected, sources, reason: null }
  const request_context = `care-transfer-request-context.v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${'a'.repeat(64)}`
  return { id, kind: 'transfer_request', route: '/care/responsibility-transfers', expected_context_digest: digest,
    payload: { patient_id: 19, receiving_relationship_id: 20, sources: selected, reason: null, client_transfer_id: id, request_context, confirmed: true } }
}
function ack(original) {
  return { id: 31, ...original.payload, sources: [source(original.payload.sources[0].source_id)], author_user_id: 7,
    author_identity_basis: 'original-basis', receiver_doctor_user_id: 90, version: 1, status: 'pending_acceptance',
    status_snapshot_at_creation: true, requested_at: stamp, request_context_digest: digest,
    authorization_snapshot: [['original-synthetic-receipt']], payload_digest: 'e'.repeat(64), submission_status: 'committed', legacy: false }
}
const rejection = code => Object.assign(new Error('synthetic authoritative result'), { statusCode: code })
async function rejected(q, h, id) {
  h.setRequest(async () => { throw rejection(409) }); assert.equal(await q.syncQueued(id), false)
  h.setRequest(async () => { throw rejection(404) }); assert.equal(await q.queryQueuedStatus(id), false)
}

test('a rejected POST and original-ID 404 retain the blocker and permit one explicit local archive without losing originals', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'), original = entry('original'), other = entry('other', 13)
    q.enqueue(original); q.enqueue(other); await rejected(q, h, original.id)
    const stored = q.pendingEntries()[0]
    assert.equal(stored.status, 'conflict_blocked')
    assert.equal(q.canArchive(stored), true)
    assert.equal(q.archiveQueued(original.id, { confirmed: true }), true)
    assert.deepEqual(q.pendingEntries().map(row => row.id), ['other'])
    assert.deepEqual(q.allEntries()[0].payload, original.payload)
    assert.equal(q.allEntries()[0].fingerprint, stored.fingerprint)
    assert.equal(q.allEntries()[0].status, 'archived_unconfirmed')
    assert.equal(require('../utils/session-privacy').summarizePatientData().pendingCount, 2)
    let writes = 0
    h.setRequest(async options => { if (options.method === 'POST') writes++; return ack(original) })
    assert.equal(await q.syncQueued(original.id), false); assert.equal(writes, 0)
    assert.equal(await q.queryQueuedStatus(original.id), true)
    assert.deepEqual(q.allEntries().map(row => row.id), ['other'])
  } finally { h.restore() }
})

test('unknown submissions, an unconfirmed archive and a lost retried POST cannot borrow a previous rejection', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'), original = entry('original'); q.enqueue(original)
    h.setRequest(async () => { throw rejection(404) }); await q.queryQueuedStatus(original.id)
    assert.equal(q.archiveQueued(original.id, { confirmed: true }), false)
    await rejected(q, h, original.id)
    assert.equal(q.archiveQueued(original.id), false)
    h.setRequest(async () => { throw new Error('POST may have committed; ACK lost') })
    await q.syncQueued(original.id)
    h.setRequest(async () => { throw rejection(404) }); await q.queryQueuedStatus(original.id)
    assert.equal(q.canArchive(q.pendingEntries()[0]), false)
    assert.equal(q.archiveQueued(original.id, { confirmed: true }), false)
    assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
  } finally { h.restore() }
})

test('archive persistence failure cannot unlock a blocked original or send a replacement', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'), original = entry('original'); q.enqueue(original); await rejected(q, h, original.id)
    const save = wx.setStorageSync; wx.setStorageSync = () => { throw new Error('synthetic storage unavailable') }
    assert.throws(() => q.archiveQueued(original.id, { confirmed: true }))
    wx.setStorageSync = save
    assert.equal(q.pendingEntries()[0].id, original.id)
    assert.throws(() => q.enqueue(entry('replacement')), /原件|核对/)
  } finally { h.restore() }
})

function pageTransport(h) {
  const state = { posts: [], modals: [], preflights: [] }
  wx.showModal = options => { state.modals.push(options); options.success({ confirm: true }) }
  h.setRequest(async options => {
    if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 19 }] }
    if (options.url.includes('/options?')) return { sources: [source(12), source(13)], receiving_relationships: [{ relationship_id: 20, doctor_user_id: 90, institution_id: '合成机构' }] }
    if (options.url === '/care/responsibility-transfers?patient_id=19') return { items: [] }
    if (options.url.endsWith('/preflight')) {
      state.preflights.push(options.data)
      const original = entry('preflight', options.data.sources[0].source_id)
      return { request_context: original.payload.request_context, request_context_digest: digest, sources: [source(options.data.sources[0].source_id)], receiver_doctor_user_id: 90 }
    }
    if (options.method === 'POST') { state.posts.push(options.data); throw rejection(409) }
    if (options.url.includes('/submissions/')) throw rejection(404)
    throw new Error('Unexpected route ' + options.url)
  })
  return state
}
async function blockedPage(h) {
  const state = pageTransport(h), page = h.load('responsibility-transfers'); await page._loadPromise
  page.selectSources({ detail: { value: ['attention:12'] } }); page.selectReceiver({ detail: { value: '0' } })
  await page.propose(); await page.queryPending()
  return { state, page, original: require('../utils/submission-queue').pendingEntries()[0] }
}

test('page explicitly retains one rejected original then rereads sources and requires new selection, context, ID and confirmation', async () => {
  const h = createHarness()
  try {
    const { state, page, original } = await blockedPage(h), q = require('../utils/submission-queue')
    assert.equal(page.data.canArchivePending, true)
    assert.equal(await page.archivePending(), true)
    assert.equal(page.data.pendingId, ''); assert.deepEqual(page.data.selectedSources, [])
    assert.equal(page.data.receiverIndex, -1); assert.equal(state.posts.length, 1)
    assert.match(state.modals.at(-1).content, /原件.*保留/); assert.match(state.modals.at(-1).content, /不表示.*撤销/)
    assert.equal(page.selectSources({ detail: { value: ['attention:13'] } }), true)
    page.selectReceiver({ detail: { value: '0' } })
    h.advance(1)
    await page.propose()
    assert.equal(state.posts.length, 2); assert.equal(state.preflights.length, 2)
    assert.notEqual(state.posts[1].client_transfer_id, original.id)
    assert.notEqual(state.posts[1].request_context, original.payload.request_context)
    assert.equal(state.modals.length, 3)
    assert.deepEqual(q.allEntries()[0].payload, original.payload)
    const recovery = h.load('submission-queue')
    assert.equal(recovery.data.entries.length, 2)
    assert.equal(recovery.data.entries[0].canRetry, false)
    assert.equal(await recovery.retry({ currentTarget: { dataset: { id: original.id } } }), false)
    assert.equal(state.posts.length, 2)
    assert.equal(recovery.viewOriginal({ currentTarget: { dataset: { id: original.id } } }), true)
    assert.match(recovery.data.originalText, /original-synthetic|care-transfer-request-context/)
  } finally { h.restore() }
})

test('a cancelled archive modal and a late same-account hidden-page confirmation preserve the active original', async () => {
  const h = createHarness()
  try {
    const { page, original } = await blockedPage(h), q = require('../utils/submission-queue')
    wx.showModal = options => options.success({ confirm: false })
    assert.equal(await page.archivePending(), false); assert.equal(q.pendingEntries()[0].id, original.id)
    let finish; wx.showModal = options => { finish = () => options.success({ confirm: true }) }
    const waiting = page.archivePending(); await h.flush()
    page.onHide(); await page.onShow(); finish()
    assert.equal(await waiting, false)
    assert.equal(q.pendingEntries()[0].id, original.id)
  } finally { h.restore() }
})

test('404 querying or an unrelated reply cannot clear a prior write blocker or trigger an automatic POST', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'); q.enqueue(entry('original')); await rejected(q, h, 'original')
    let writes = 0
    h.setRequest(async options => { if (options.method === 'POST') writes++; return { id: 999, submission_status: 'committed' } })
    await q.queryQueuedStatus('original')
    assert.equal(q.pendingEntries()[0].status, 'conflict_blocked'); assert.equal(q.canArchive(q.pendingEntries()[0]), false)
    assert.equal(await q.retryPending(), 0); assert.equal(writes, 0)
  } finally { h.restore() }
})

for (const kind of ['transfer_decision', 'transfer_work_action']) test(`actual doctor ${kind} archive preserves its own original and remains GET-only`, async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    const q = require('../utils/submission-queue'), decision = kind === 'transfer_decision', prefix = decision ? 'decision' : 'work'
    const context = { purpose: `care_transfer_${prefix}`, context_version: 1, actor_user_id: 7, actor_identity_basis: 'original-doctor-basis',
      patient_id: 19, authorization_snapshot: [['original-doctor-receipt']], ...(decision
        ? { transfer_id: 31, expected_version: 1, allowed_decisions: ['accept', 'reject'], source_count: 1 }
        : { work_item_id: 51, expected_version: 1, previous_status: 'open' }) }
    const payload = { patient_id: 19, expected_version: 1, reason: null, confirmed: true, ...(decision
      ? { client_decision_id: 'doctor-original', transfer_id: 31, decision: 'accept' }
      : { client_action_id: 'doctor-original', work_item_id: 51, action: 'acknowledge' }),
      [decision ? 'decision_context' : 'action_context']: `care-transfer-${prefix}-context.v1.${Buffer.from(JSON.stringify(context)).toString('base64url')}.${'a'.repeat(64)}` }
    q.enqueue({ id: 'doctor-original', kind, payload, expected_context_digest: digest,
      route: decision ? '/care/responsibility-transfer-decisions' : '/care/transferred-work-actions' })
    h.setRequest(async () => { throw rejection(403) }); await q.syncQueued('doctor-original')
    h.setRequest(async () => { throw rejection(404) }); await q.queryQueuedStatus('doctor-original')
    assert.equal(q.pendingEntries()[0].status, 'authorization_blocked')
    assert.equal(q.archiveQueued('doctor-original', { confirmed: true }), true)
    assert.deepEqual(q.allEntries()[0].payload, payload)
    assert.equal(await q.syncQueued('doctor-original'), false)
    assert.equal(require('../utils/session-privacy').summarizePatientData().pendingCount, 1)
  } finally { h.restore() }
})

test('local archive keeps full capacity accounting and cannot race an in-flight original query', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'); q.enqueue(entry('original')); await rejected(q, h, 'original')
    let finish
    h.setRequest(() => new Promise(resolve => { finish = () => resolve({ id: 999 }) }))
    const waiting = q.queryQueuedStatus('original'); await h.flush()
    assert.equal(q.archiveQueued('original', { confirmed: true }), false)
    finish(); await waiting
    await rejected(q, h, 'original'); assert.equal(q.archiveQueued('original', { confirmed: true }), true)
    for (let i = 1; i < q.MAX_ENTRIES; i++) q.enqueue(entry('other-' + i, 100 + i))
    assert.equal(q.allEntries().length, q.MAX_ENTRIES)
    assert.throws(() => q.enqueue(entry('over-capacity', 999)), /容量已满/)
    assert.deepEqual(q.allEntries()[0].payload, entry('original').payload)
  } finally { h.restore() }
})

test('a late recovery archive modal cannot retire a replacement account original with the same ID', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'); q.enqueue(entry('original')); await rejected(q, h, 'original')
    const page = h.load('submission-queue')
    let finish; wx.showModal = options => { finish = () => options.success({ confirm: true }) }
    const waiting = page.archive({ currentTarget: { dataset: { id: 'original' } } }); await h.flush()
    require('../utils/session-privacy').replacePatientSession({ access_token: 'replacement-account', user: { id: 9, role: 'patient' } })
    q.enqueue({ id: 'original', kind: 'legacy_cognitive', route: '/patient/submit_cognitive_test', payload: {
      patient_id: 90, test_type: 'flanker', result_json: { test_run_id: 'other-account-run', raw_result: { accuracy: 20 } } } })
    finish(); assert.equal(await waiting, false)
    assert.equal(q.pendingEntries().length, 1); assert.equal(q.pendingEntries()[0].status, 'pending_sync')
    assert.equal(q.pendingEntries()[0].payload.patient_id, 90)
  } finally { h.restore() }
})
