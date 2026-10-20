const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

// This probe records the recovery dead end, not a successful spec result.
test('independent reproduction: a rejected original request blocks even unrelated fresh source confirmation', async () => {
  const h = createHarness()
  const source = { source_type: 'attention', source_id: 12, expected_version: 1, from_doctor_user_id: 80 }
  const other = { source_type: 'attention', source_id: 13, expected_version: 1, from_doctor_user_id: 80 }
  const relation = { relationship_id: 20, doctor_user_id: 90, institution_id: 'synthetic-institution' }
  let posts = 0, queries = 0
  try {
    wx.showModal = options => options.success({ confirm: true })
    h.setRequest(async options => {
      if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 19 }] }
      if (options.url.endsWith('/options?patient_id=19')) return { patient_id: 19, sources: [source, other], receiving_relationships: [relation] }
      if (options.url === '/care/responsibility-transfers?patient_id=19') return { items: [] }
      if (options.url.endsWith('/preflight')) {
        const value = { purpose: 'care_transfer_request', context_version: 1, actor_user_id: 7,
          actor_identity_basis: 'synthetic-original-basis', patient_id: 19, authorization_snapshot: [['original-synthetic-receipt']],
          selected: options.data.sources, sources: [source], receiving_relationship_id: 20,
          receiver_doctor_user_id: 90, reason: options.data.reason }
        return { request_context: `care-transfer-request-context.v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${'a'.repeat(64)}`,
          request_context_digest: 'd'.repeat(64), receiver_doctor_user_id: 90, sources: [source] }
      }
      if (options.url === '/care/responsibility-transfers' && options.method === 'POST') {
        posts++
        throw Object.assign(new Error('authoritative source-version conflict before creation'), { statusCode: 409 })
      }
      if (options.url.includes('/submissions/')) {
        queries++
        throw Object.assign(new Error('original request was not created'), { statusCode: 404 })
      }
      throw new Error('Unexpected independent probe route: ' + options.url)
    })
    const page = h.load('responsibility-transfers')
    await page._loadPromise
    page.selectSources({ detail: { value: ['attention:12'] } })
    page.selectReceiver({ detail: { value: '0' } })
    assert.equal(await page.propose(), false)
    const queue = require('../utils/submission-queue')
    const original = queue.pendingEntries()[0]
    assert.equal(original.status, 'conflict_blocked')
    assert.equal(await page.queryPending(), false)
    assert.equal(queries, 1)
    page.onHide(); await page.onShow()
    assert.equal(page.data.pendingId, original.id)
    assert.equal(page.selectSources({ detail: { value: ['attention:13'] } }), false)
    assert.equal(await page.propose(), false)
    assert.equal(posts, 1)
    assert.equal(queue.pendingEntries().length, 1)
    assert.deepEqual(queue.pendingEntries()[0].payload, original.payload)
    console.log('CONFIRMED SPEC GAP: explicit 409 + original-ID 404 + reopen still blocks an unrelated selected source; original is retained, no per-entry retirement is exposed.')
  } finally { h.restore() }
})
