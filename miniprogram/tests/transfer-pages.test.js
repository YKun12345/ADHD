const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const stamp = '2026-10-16T04:00:00+00:00', digest = 'd'.repeat(64)
const source = { source_type: 'attention', source_id: 12, expected_version: 1, from_doctor_user_id: 80 }
const relation = { relationship_id: 20, doctor_user_id: 90, institution_id: '合成机构' }
const token = (kind, value) => `care-transfer-${kind}-context.v1.${Buffer.from(JSON.stringify({ purpose: `care_transfer_${kind}`, context_version: 1,
  actor_user_id: 7, actor_identity_basis: 'synthetic-actual-basis', patient_id: 19, authorization_snapshot: [['original-synthetic-receipt']], ...value })).toString('base64url')}.${'a'.repeat(64)}`
function arrange(h, lost = false, onList = null) {
  let saved, writes = 0
  wx.showModal = options => options.success({ confirm: true })
  h.setRequest(async options => {
    if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 19 }] }
    if (options.url.includes('/options')) return { patient_id: 19, sources: [source], receiving_relationships: [relation] }
    if (options.url === '/care/responsibility-transfers?patient_id=19') return onList ? onList() : { items: [] }
    if (options.url.endsWith('/preflight')) return { request_context: token('request', { selected: options.data.sources, sources: [source],
      receiving_relationship_id: 20, receiver_doctor_user_id: 90, reason: options.data.reason }), request_context_digest: digest,
      sources: [source], receiver_doctor_user_id: 90 }
    if (options.method === 'POST') {
      writes++
      saved = { id: 31, ...options.data, sources: [source], author_user_id: 7, author_identity_basis: 'synthetic-actual-basis',
        receiver_doctor_user_id: 90, version: 1, status: 'pending_acceptance', status_snapshot_at_creation: true, requested_at: stamp,
        request_context_digest: digest, authorization_snapshot: [['original-synthetic-receipt']], payload_digest: 'e'.repeat(64), submission_status: 'committed', legacy: false }
      if (lost) throw new Error('synthetic lost ACK')
      return saved
    }
    if (options.url.includes('/submissions/')) return saved
    throw new Error('unexpected route ' + options.url)
  })
  return () => writes
}

test('handover requires an explicit actual object list, recipient and user confirmation', async () => {
  const h = createHarness()
  try {
    const writes = arrange(h), page = h.load('responsibility-transfers'); await page._loadPromise
    assert.equal(page.data.sources.length, 1)
    assert.equal(await page.propose(), false); assert.equal(writes(), 0)
    page.selectSources({ detail: { value: ['attention:12'] } }); page.selectReceiver({ detail: { value: '0' } })
    wx.showModal = options => options.success({ confirm: false })
    assert.equal(await page.propose(), false); assert.equal(writes(), 0)
    wx.showModal = options => options.success({ confirm: true })
    assert.equal(await page.propose(), true, page.data.errorText)
    assert.equal(writes(), 1); assert.match(page.data.statusText, /等待.*接受/)
  } finally { h.restore() }
})

test('a lost request ACK survives page hiding and recovers by its exact original ID', async () => {
  const h = createHarness()
  try {
    const writes = arrange(h, true), page = h.load('responsibility-transfers'); await page._loadPromise
    page.selectSources({ detail: { value: ['attention:12'] } }); page.selectReceiver({ detail: { value: '0' } })
    assert.equal(await page.propose(), false)
    const original = require('../utils/submission-queue').pendingEntries()[0]
    assert.equal(page.data.pendingId, original.id)
    page.onHide(); assert.deepEqual(page.data.sources, []); await page.onShow()
    assert.equal(await page.queryPending(), true); assert.equal(writes(), 1)
    assert.deepEqual(require('../utils/submission-queue').pendingEntries(), [])
    page.onHide(); require('../utils/session-privacy').replacePatientSession({ access_token: 'other', user: { id: 9, role: 'patient' } })
    assert.equal(await page.onShow(), false); assert.deepEqual(page.data.sources, [])
  } finally { h.restore() }
})

test('successor work page reads actual accepted responsibility, selected original evidence and actor history', async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    h.setRequest(async options => {
      const work = { id: 51, patient_id: 19, transfer_id: 31, decision_id: 41, responsible_doctor_id: 7, from_doctor_user_id: 80,
        original_attention_id: 12, accepted_at: stamp, status: 'open', version: 1, response_coverage: { status: 'not_configured' }, original_provenance_preserved: true }
      if (options.url === '/care/transferred-work') return { items: [work] }
      if (options.url.endsWith('/history')) return { work_item_id: 51, patient_id: 19, items: [] }
      return { work, original_evidence: { kind: 'assessment_quality', quality_reasons: ['execution_interrupted'], evidence: {
        submission_id: 'actual-original-evidence', quality_status: 'limited', server_result: { kind: 'cognitive', id: 71,
          result_json: { raw_result: { total_trials: 24, accuracy: 100, omissions: 0 }, trials: Array.from({ length: 24 }, () => ({ outcome: 'correct', responseTimeMs: 400 })) } } } }, allowed_actions: ['acknowledge', 'close_with_reason'],
        action_context: token('work', { work_item_id: 51, expected_version: 1, previous_status: 'open' }), action_context_digest: digest }
    })
    const page = h.load('transferred-work'); await page._loadPromise
    assert.equal(page.data.items.length, 1)
    assert.equal(await page.openWork({ currentTarget: { dataset: { id: 51 } } }), true)
    assert.equal(page.data.detail.work.id, 51); assert.match(page.data.evidenceText, /中断/)
    assert.match(page.data.resultText, /正确率.*100%.*24.*漏答.*0/)
    assert.equal(page.data.trials[0].timeText, '400 毫秒')
    assert.deepEqual(page.data.history, [])
    page.onHide(); assert.equal(page.data.detail, null)
  } finally { h.restore() }
})

test('hiding and reopening during a committed handover refresh prevents the old operation repainting the new page', async () => {
  const h = createHarness()
  try {
    let reads = 0, release
    arrange(h, false, () => ++reads === 2 ? new Promise(resolve => { release = () => resolve({ items: [] }) }) : { items: [] })
    const page = h.load('responsibility-transfers'); await page._loadPromise
    page.selectSources({ detail: { value: ['attention:12'] } }); page.selectReceiver({ detail: { value: '0' } })
    const submitted = page.propose()
    for (let i = 0; i < 50 && !release; i++) await h.flush()
    assert.ok(release)
    page.onHide(); await page.onShow(); assert.equal(page.data.statusText, '')
    release(); assert.equal(await submitted, false)
    assert.equal(page.data.statusText, '')
  } finally { h.restore() }
})
