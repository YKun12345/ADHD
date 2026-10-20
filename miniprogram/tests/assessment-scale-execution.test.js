const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const { snapshot } = require('./helpers/assessment-snapshot')
const { ASRS_CONFIG } = require('../utils/asrs-scale')
const query = { assessment_id: '42', item_id: '71', attempt_id: '53' }
function scaleSnapshot() {
  const value = snapshot(), item = value.items[0], attempt = item.attempts[0]
  Object.assign(item, { kind: 'scale', instrument: 'ASRS', config: { ...ASRS_CONFIG }, content_digest: 'b'.repeat(64), recall_window: 'P6M' })
  Object.assign(attempt, { config_snapshot: item.config, performer_kind: 'user', performer_user_id: 7, performer_patient_id: null, respondent_user_id: 7, respondent_kind: 'self', recall_window: 'P6M' })
  return value
}
test('formal scale answers belong to the actual attempt, never inherit a legacy draft, and submit through the durable queue', async () => {
  const h = createHarness()
  try {
    h.storage.scale_draft_asrs = Array(18).fill(4)
    const server = scaleSnapshot()
    h.setRequest(async options => options.url.endsWith('/evidence') ? { submission_id: 'wx-server-fixed-run',
      context: h.requests.find(value => value.method === 'POST').data,
      server_result: { kind: 'scale', id: 99, total_score: 18, risk_level: 'low', score_json: {}, legacy: false }, ack: { submission_id: 'wx-server-fixed-run' } }
      : options.method !== 'POST' ? server : { ...Object.fromEntries(['submission_id', 'patient_id', 'assessment_id', 'assessment_item_id', 'attempt_id', 'run_id', 'task_id'].map(key => [key, options.data[key]])),
        submission_status: 'committed', execution_status: 'submitted', canonical_digest: 'a'.repeat(64), result: { kind: 'scale', id: 99, legacy: false }, quality_status: 'valid', acceptance_status: 'not_required' })
    const page = h.load('scale', { query }); await page._loadPromise
    assert.deepEqual(page.data.answers, [])
    for (let index = 0; index < 18; index++) {
      page.selectOption({ currentTarget: { dataset: { value: 1 } } })
      if (index < 17) page.goNext()
    }
    assert.equal(require('../utils/session-privacy').summarizePatientData().draftCount, 2, 'legacy草稿和本轮草稿都应计入隐私页本机资料')
    await page.submitScale()
    const writes = h.requests.filter(row => row.method === 'POST')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].url, '/care/submissions')
    assert.equal(writes[0].data.attempt_id, 53)
    assert.equal(writes[0].data.content.recall_window, 'P6M')
    assert.deepEqual(writes[0].data.content.answers, Array(18).fill(1))
    assert.equal(page.data.formalCommitted, true)
    assert.equal(page.data.result.total_score, 18)
    assert.equal(h.storage.submission_queue_v1.entries.length, 0)
    assert.deepEqual(h.storage.scale_draft_asrs, Array(18).fill(4))
  } finally { h.restore() }
})

test('formal scale draft storage failure retains selected answers but never claims they were saved', async () => {
  const h = createHarness()
  try {
    h.setRequest(async () => scaleSnapshot())
    const page = h.load('scale', { query }); await page._loadPromise
    wx.setStorageSync = () => { throw new Error('synthetic storage failure') }
    page.selectOption({ currentTarget: { dataset: { value: 2 } } })
    assert.deepEqual(page.data.answers, [2])
    assert.match(page.data.draftStatus, /未保存/)
    assert.equal(h.requests.some(row => row.method === 'POST'), false)
  } finally { h.restore() }
})

test('an unsaved scale submission can still be corrected before the first durable queue write', async () => {
  const h = createHarness()
  try {
    h.setRequest(async options => options.method === 'POST' ? {} : scaleSnapshot())
    const page = h.load('scale', { query }); await page._loadPromise
    page.setData({ answers: Array(18).fill(1) })
    const write = wx.setStorageSync
    wx.setStorageSync = (key, value) => { if (key === 'submission_queue_v1') throw new Error('synthetic queue quota'); return write(key, value) }
    await page.submitScale()
    assert.equal(h.requests.some(row => row.method === 'POST'), false)
    wx.setStorageSync = write
    page.selectOption({ currentTarget: { dataset: { value: 2 } } })
    await page.submitScale()
    assert.equal(h.requests.find(row => row.method === 'POST').data.content.answers[0], 2)
  } finally { h.restore() }
})
