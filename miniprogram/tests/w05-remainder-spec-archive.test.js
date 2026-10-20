// Independent post-repair spec checks exercise actual page and durable queue.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const event = id => ({ currentTarget: { dataset: { id } } })
const rejected = code => Object.assign(new Error('synthetic explicit result'), { statusCode: code })
const source = id => ({ source_type: 'attention', source_id: id, expected_version: 1, from_doctor_user_id: 80 })
const stamp = '2026-10-16T05:00:00+00:00'

function original(id, sourceId = 12) {
  const sources = [source(sourceId)], selected = sources.map(({ from_doctor_user_id, ...row }) => row)
  const context = { purpose: 'care_transfer_request', context_version: 1, actor_user_id: 7,
    actor_identity_basis: 'independent-original-self', patient_id: 19, authorization_snapshot: [['independent-original-receipt']],
    receiving_relationship_id: 20, receiver_doctor_user_id: 90, selected, sources, reason: null }
  return { id, kind: 'transfer_request', route: '/care/responsibility-transfers', expected_context_digest: 'd'.repeat(64),
    payload: { patient_id: 19, receiving_relationship_id: 20, sources: selected, reason: null,
      client_transfer_id: id, confirmed: true,
      request_context: `care-transfer-request-context.v1.${Buffer.from(JSON.stringify(context)).toString('base64url')}.${'a'.repeat(64)}` } }
}
function acknowledgement(entry) {
  return { id: 31, client_transfer_id: entry.id, patient_id: 19, author_user_id: 7,
    author_identity_basis: 'independent-original-self', receiver_doctor_user_id: 90, receiving_relationship_id: 20,
    requested_at: stamp, version: 1, request_context_digest: entry.expected_context_digest, payload_digest: 'e'.repeat(64),
    authorization_snapshot: [['independent-original-receipt']], sources: [source(entry.payload.sources[0].source_id)],
    reason: null, status: 'pending_acceptance', status_snapshot_at_creation: true, confirmed: true,
    submission_status: 'committed', legacy: false }
}
async function block(q, h, id, code = 409) {
  h.setRequest(async () => { throw rejected(code) }); assert.equal(await q.syncQueued(id), false)
  h.setRequest(async () => { throw rejected(404) }); assert.equal(await q.queryQueuedStatus(id), false)
}
function transport(h) {
  const calls = [], modals = []
  wx.showModal = options => { modals.push(options); options.success({ confirm: true }) }
  h.setRequest(async options => {
    calls.push({ url: options.url, method: options.method, body: options.data })
    if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 19 }] }
    if (options.url.includes('/options?')) return { patient_id: 19, sources: [source(12), source(13)],
      receiving_relationships: [{ relationship_id: 20, doctor_user_id: 90, institution_id: 'Independent synthetic institution' }] }
    if (options.url === '/care/responsibility-transfers?patient_id=19') return { items: [] }
    if (options.url.endsWith('/preflight')) {
      const entry = original('preflight', options.data.sources[0].source_id)
      return { request_context: entry.payload.request_context, request_context_digest: entry.expected_context_digest,
        sources: [source(options.data.sources[0].source_id)], receiver_doctor_user_id: 90 }
    }
    if (options.url === '/care/responsibility-transfers' && options.method === 'POST') throw rejected(409)
    if (options.url.includes('/submissions/')) throw rejected(404)
    throw new Error('Unexpected independent route ' + options.url)
  })
  return { calls, modals }
}

test('independent spec: archivePending retains exact original and requires fresh explicit recipient, sources, context and ID', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'), state = transport(h), page = h.load('responsibility-transfers')
    await page._loadPromise
    page.selectSources({ detail: { value: ['attention:12'] } }); page.selectReceiver({ detail: { value: '0' } })
    assert.equal(await page.propose(), false)
    const before = q.pendingEntries()[0]
    assert.equal(await page.archivePending(), false) // No original-ID lookup yet.
    assert.equal(await page.queryPending(), false)
    assert.equal(page.data.canArchivePending, true)
    assert.equal(await page.archivePending(), true)
    assert.match(state.modals.at(-1).content, /不表示已撤销服务器请求/)
    assert.equal(page.data.pendingId, '')
    assert.deepEqual(page.data.selectedSources, [])
    assert.equal(page.data.receiverIndex, -1)
    assert.equal(q.pendingEntries().length, 0)
    assert.equal(q.allEntries()[0].status, 'archived_unconfirmed')
    assert.deepEqual(q.allEntries()[0].payload, before.payload)
    assert.equal(q.allEntries()[0].fingerprint, before.fingerprint)
    assert.equal(require('../utils/session-privacy').summarizePatientData().pendingCount, 1)
    assert.equal(await page.propose(), false) // Refreshed data alone is not new authorization.
    assert.equal(page.selectSources({ detail: { value: ['attention:13'] } }), true)
    assert.equal(page.selectReceiver({ detail: { value: '0' } }), true)
    h.advance(1)
    assert.equal(await page.propose(), false) // A new explicit request is sent, then independently rejected.
    const posted = state.calls.filter(call => call.method === 'POST' && call.url === '/care/responsibility-transfers')
    assert.equal(posted.length, 2)
    assert.notEqual(posted[1].body.client_transfer_id, before.id)
    assert.notEqual(posted[1].body.request_context, before.payload.request_context)
    assert.deepEqual(posted[1].body.sources, [{ source_type: 'attention', source_id: 13, expected_version: 1 }])
    assert.equal(state.modals.length, 3)
    assert.deepEqual(q.allEntries()[0].payload, before.payload)
  } finally { h.restore() }
})

test('independent spec: recovery archive and viewOriginal preserve one exact body and only exact GET ACK retires that item', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'), first = original('independent-first'), second = original('independent-second', 13)
    q.enqueue(first); q.enqueue(second); await block(q, h, first.id, 403)
    const page = h.load('submission-queue')
    assert.equal(page.viewOriginal(event(first.id)), true)
    const shown = JSON.parse(page.data.originalText)
    assert.equal(shown.original_id, first.id); assert.deepEqual(shown.payload, first.payload)
    wx.showModal = options => options.success({ confirm: false })
    assert.equal(await page.archive(event(first.id)), false)
    assert.equal(q.pendingEntries().length, 2)
    wx.showModal = options => options.success({ confirm: true })
    assert.equal(await page.archive(event(first.id)), true)
    assert.deepEqual(q.pendingEntries().map(item => item.id), [second.id])
    assert.equal(page.viewOriginal(event(first.id)), true)
    assert.deepEqual(JSON.parse(page.data.originalText).payload, first.payload)
    let writes = 0
    h.setRequest(async options => { if (options.method === 'POST') writes++; return { ...acknowledgement(first), author_user_id: 999 } })
    assert.equal(await page.retry(event(first.id)), false)
    assert.equal(await page.queryStatus(event(first.id)), false)
    assert.equal(q.allEntries().length, 2)
    assert.equal(q.allEntries()[0].status, 'archived_unconfirmed')
    h.setRequest(async options => { assert.equal(options.method || 'GET', 'GET'); return acknowledgement(first) })
    assert.equal(await page.queryStatus(event(first.id)), true)
    assert.deepEqual(q.allEntries().map(item => item.id), [second.id])
    assert.equal(writes, 0)
    page.onHide(); assert.equal(page.data.originalText, '')
  } finally { h.restore() }
})

test('independent spec: recovery archive late modal and view cannot cross a hidden page or replacement session', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'), entry = original('independent-hidden')
    q.enqueue(entry); await block(q, h, entry.id)
    const page = h.load('submission-queue')
    let complete
    wx.showModal = options => { complete = () => options.success({ confirm: true }) }
    const pending = page.archive(event(entry.id)); await h.flush()
    page.onHide(); page.onShow(); complete()
    assert.equal(await pending, false); assert.equal(q.pendingEntries().length, 1)
    require('../utils/session-privacy').replacePatientSession({ access_token: 'replacement', user: { id: 9, role: 'patient' } })
    assert.equal(page.viewOriginal(event(entry.id)), false)
    assert.equal(page.data.originalText, '')
    assert.deepEqual(q.allEntries(), [])
  } finally { h.restore() }
})
