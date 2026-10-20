// Independent local-persistence and page-lifecycle recovery probes.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const tap = dataset => ({ currentTarget: { dataset } })
const body = { patient_id: 8, cycle_id: 21, record_date: '2026-10-01', client_submission_id: 'quality-original',
  expected_revision: 1, recorded_at: '2026-10-01T00:17:03.123456Z',
  content: { focus_minutes: 0, note: '合成待同步原件', is_medication: false, attention_rating: 2 } }
const acknowledgement = payload => ({ ...payload, actor_user_id: 7, record_id: 45,
  revision: payload.expected_revision + 1, content_digest: 'a'.repeat(64), submission_status: 'committed', legacy: false })
const cycle = { id: 21, patient_id: 8, cycle_type: 'self', start_date: '2026-10-01', end_date: '2026-10-14',
  calendar_timezone: 'Asia/Shanghai', responsible_doctor_id: null, plan_version_id: null, allowed_actions: ['create_daily'] }
const detail = { ...cycle, summary: { as_of_date: '2026-10-15', due_count: 14, completed_count: 1, missing_dates: ['2026-10-02'] },
  records: [{ ...acknowledgement(body), record_id: 44, revision: 1 }] }

test('ACK followed by local deletion failure preserves the exact original across module reload and query-only recovery', async () => {
  const h = createHarness()
  try {
    let q = require('../utils/submission-queue')
    q.enqueue({ id: body.client_submission_id, kind: 'cycle_daily', route: '/care/daily-records', payload: body })
    const original = q.pendingEntries()[0], save = wx.setStorageSync
    wx.setStorageSync = (key, value) => {
      if (key === q.QUEUE_KEY && value.entries.length === 0) throw new Error('synthetic disk failure before deletion')
      return save(key, value)
    }
    h.setRequest(async options => acknowledgement(options.data))
    assert.equal(await q.syncQueued(original.id), false)
    assert.deepEqual(q.pendingEntries()[0].payload, body)
    assert.equal(q.pendingEntries()[0].fingerprint, original.fingerprint)
    wx.setStorageSync = save
    delete require.cache[require.resolve('../utils/submission-queue')]
    q = require('../utils/submission-queue')
    assert.deepEqual(q.pendingEntries()[0].payload, body)
    h.setRequest(async options => {
      assert.equal(options.url, '/care/daily-records/quality-original')
      assert.equal(options.method, undefined)
      return acknowledgement(body)
    })
    assert.equal(await q.queryQueuedStatus(original.id), true)
    assert.equal(q.pendingEntries().length, 0)
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1)
    assert.equal(h.requests.length, 2)
  } finally { h.restore() }
})

test('hidden page discards display data while the pending original restores unchanged and retries its original ID', async () => {
  const h = createHarness()
  try {
    const reads = async options => options.url === '/identity/context' ? { accessible_patients: [{ patient_id: 8 }] }
      : options.url.includes('?patient_id=') ? { items: [cycle], as_of_date: '2026-10-15', calendar_timezone: 'Asia/Shanghai' } : detail
    h.setRequest(reads)
    const page = h.load('care-cycles'); await page._loadPromise; await page.openCycle(tap({ id: 21 }))
    page.selectRecordDate({ detail: { value: '2026-10-01' } })
    page.onDailyInput({ currentTarget: { dataset: { field: 'note' } }, detail: { value: '待同步的新备注' } })
    let reject
    h.setRequest(() => new Promise((resolve, fail) => { reject = fail }))
    const upload = page.saveDaily(); await Promise.resolve()
    const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
    assert.equal(original.payload.recorded_at, body.recorded_at)
    page.onHide()
    assert.equal(page.data.cycle, null); assert.equal(page.data.note, ''); assert.deepEqual(page.data.records, [])
    assert.deepEqual(q.pendingEntries()[0].payload, original.payload)
    reject(new Error('synthetic offline after hide')); assert.equal(await upload, false)
    h.setRequest(reads); assert.equal(await page.onShow(), true)
    assert.equal(await page.openCycle(tap({ id: 21 })), true)
    assert.equal(page.data.pendingId, original.id)
    assert.equal(page.data.note, '待同步的新备注')
    assert.equal(page.data.focusMinutes, '0')
    page.onDailyInput({ currentTarget: { dataset: { field: 'note' } }, detail: { value: '不能替换原件' } })
    assert.equal(page.data.note, '待同步的新备注')
    h.setRequest(async options => {
      if (options.method === 'POST') {
        assert.deepEqual(options.data, original.payload)
        return acknowledgement(options.data)
      }
      return { ...detail, records: [acknowledgement(original.payload)] }
    })
    assert.equal(await page.saveDaily(), true)
    assert.equal(q.pendingEntries().length, 0)
    assert.equal(page.data.pendingId, '')
    assert.equal(page.data.records[0].revision, 2)
    assert.equal(page.data.records[0].content.is_medication, false)
    assert.equal(page.data.records[0].content.attention_rating, 2)
  } finally { h.restore() }
})
