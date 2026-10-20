const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const { syntheticSendContext } = require('./helpers/shared-message-context')

test('the actual daily page reads its real cycle before applying only the prepared note and still requires save', async () => {
  const h = createHarness()
  try {
    const transfer = require('../utils/companion-transfer')
    const binding = { kind: 'daily', patientId: 8, cycleId: 3, recordDate: '2026-10-18', recordRevision: 0, cycleStatus: 'active', planVersionId: null }
    const id = transfer.prepare(binding, { note: '今天写作业时走神，没有记录专注分钟数' })
    const cycle = { id: 3, patient_id: 8, processing_status: 'active', plan_version_id: null, start_date: '2026-10-18', end_date: '2026-10-31',
      allowed_actions: ['create_daily'], records: [], summary: { as_of_date: '2026-10-18', completed_count: 0, due_count: 1 } }
    h.setRequest(async options => {
      if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 8 }] }
      if (options.url === '/care/cycles?patient_id=8') return { items: [cycle], as_of_date: '2026-10-18' }
      if (options.url === '/care/cycles/3') return cycle
      throw new Error(options.url)
    })
    const page = h.load('care-cycles', { query: { patient_id: '8', cycle_id: '3', companion_transfer: id } }); await page._loadPromise
    assert.equal(page.data.note, '今天写作业时走神，没有记录专注分钟数')
    assert.equal(page.data.focusMinutes, '')
    assert.match(page.data.statusText, /尚未保存/)
    assert.equal(h.requests.some(row => row.method === 'POST'), false)
    assert.equal(transfer.consume(id, binding), null)
  } finally { require('../utils/companion-transfer').clear(); h.restore() }
})

test('shared-message hand-off uses the freshly verified exact relationship and refuses a changed original version', async () => {
  for (const changed of [false, true]) {
    const h = createHarness()
    try {
      const transfer = require('../utils/companion-transfer')
      const binding = { kind: 'message', patientId: 8, relationshipId: 20, revision: 2, contextDigest: 'd'.repeat(64) }
      const id = transfer.prepare(binding, { content: '我想向医生反馈这次实际困难' })
      h.setRequest(async options => {
        if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 8 }] }
        if (options.url.startsWith('/care/shared-messages/relationships?')) return { items: [{ relationship_id: 20,
          relationship_revision: changed ? 3 : 2, doctor_user_id: 90, patient_actor_user_id: 7, patient_id: 8, scope: ['care'],
          can_send: true, send_context: syntheticSendContext(), send_context_digest: 'd'.repeat(64) }] }
        if (options.url === '/care/shared-messages?patient_id=8&relationship_id=20') return { items: [] }
        throw new Error(options.url)
      })
      const page = h.load('shared-messages', { query: { patient_id: '8', relationship_id: '20', companion_transfer: id } }); await page._loadPromise
      assert.equal(page.data.content, changed ? '' : '我想向医生反馈这次实际困难')
      assert.match(page.data.statusText, changed ? /变化|失效|重新核对/ : /尚未发送/)
      assert.equal(h.requests.some(row => row.method === 'POST'), false)
    } finally { require('../utils/companion-transfer').clear(); h.restore() }
  }
})
