const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const tap = dataset => ({ currentTarget: { dataset } })
const cycle = { id: 21, patient_id: 8, cycle_type: 'self', start_date: '2026-10-01', end_date: '2026-10-14',
  calendar_timezone: 'Asia/Shanghai', responsible_doctor_id: null, plan_version_id: null, allowed_actions: ['create_daily'] }
const detail = { ...cycle, summary: { as_of_date: '2026-10-15', due_count: 14, completed_count: 1,
  missing_dates: ['2026-10-02'], coverage: 1 / 14 }, records: [{ record_id: 40, patient_id: 8, cycle_id: 21,
    record_date: '2026-10-01', revision: 1, recorded_at: null, recorded_at_status: 'unknown', submitted_at: '2026-10-14T01:00:00Z',
    is_backfill: true, content: { focus_minutes: 0, note: '原记录' } }] }
const setup = h => h.setRequest(async options => options.url === '/identity/context' ? { accessible_patients: [{ patient_id: 8 }] }
  : options.url === '/care/cycles?patient_id=8' ? { items: [cycle], as_of_date: '2026-10-15', calendar_timezone: 'Asia/Shanghai' }
    : options.url.includes('daily-history') ? { items: detail.records } : detail)

test('real cycle controller uses server dates and original missing values, never the legacy day index', async () => {
  const h = createHarness()
  try {
    setup(h); const page = h.load('care-cycles'); await page._loadPromise
    assert.equal(page.data.today, '2026-10-15')
    await page.openCycle(tap({ id: 21 }))
    assert.equal(page.data.cycle.id, 21); assert.equal(page.data.records[0].focusText, '0 分钟')
    assert.match(page.data.records[0].recordedTimeText, /未知/)
    assert.equal(page.data.coverageText, '已记录 1 / 14 天')
    assert.equal(h.requests.some(row => row.url.includes('/dashboard') || row.url.includes('tracking_log')), false)
  } finally { h.restore() }
})

test('daily revisions stay persisted offline and a changed draft cannot replace the unacknowledged original', async () => {
  const h = createHarness()
  try {
    setup(h); const page = h.load('care-cycles'); await page._loadPromise; await page.openCycle(tap({ id: 21 }))
    page.selectRecordDate({ detail: { value: '2026-10-01' } })
    page.onDailyInput({ currentTarget: { dataset: { field: 'focusMinutes' } }, detail: { value: '35' } })
    h.setRequest(async options => { if (options.method === 'POST') throw new Error('synthetic offline'); return detail })
    assert.equal(await page.saveDaily(), false)
    const q = require('../utils/submission-queue'), first = q.pendingEntries()[0]
    assert.equal(first.kind, 'cycle_daily'); assert.equal(first.payload.expected_revision, 1)
    assert.equal(first.payload.recorded_at, null); assert.equal(first.payload.content.focus_minutes, 35)
    page.onDailyInput({ currentTarget: { dataset: { field: 'focusMinutes' } }, detail: { value: '99' } })
    assert.equal(page.data.focusMinutes, '35')
    assert.deepEqual(q.pendingEntries()[0].payload, first.payload)
  } finally { h.restore() }
})

test('exact daily ACK reloads actual revisions and history keeps the original zero observation', async () => {
  const h = createHarness()
  try {
    setup(h); const page = h.load('care-cycles'); await page._loadPromise; await page.openCycle(tap({ id: 21 }))
    page.selectRecordDate({ detail: { value: '2026-10-01' } })
    page.onDailyInput({ currentTarget: { dataset: { field: 'focusMinutes' } }, detail: { value: '35' } })
    const newRecord = { ...detail.records[0], record_id: 41, revision: 2, content: { focus_minutes: 35 } }
    h.setRequest(async options => options.method === 'POST' ? { submission_status: 'committed', legacy: false,
      record_id: 41, ...options.data, actor_user_id: 7, revision: 2, content_digest: 'a'.repeat(64) }
      : options.url.includes('daily-history') ? { items: [...detail.records, newRecord] } : { ...detail, records: [newRecord] })
    assert.equal(await page.saveDaily(), true)
    assert.equal(require('../utils/submission-queue').pendingEntries().length, 0)
    assert.equal(page.data.records[0].revision, 2)
    await page.showHistory(tap({ date: '2026-10-01' }))
    assert.deepEqual(page.data.history.map(row => row.focusText), ['0 分钟', '35 分钟'])
  } finally { h.restore() }
})

test('actual account replacement clears cycle evidence and late A reads cannot repopulate B', async () => {
  const h = createHarness()
  try {
    setup(h); const page = h.load('care-cycles'); await page._loadPromise; global.getCurrentPages = () => [page]
    let finish; h.setRequest(() => new Promise(resolve => { finish = resolve }))
    const pending = page.openCycle(tap({ id: 21 })); await Promise.resolve()
    require('../utils/session-privacy').replacePatientSession({ access_token: 'synthetic-new-B', user: { id: 9, role: 'patient', patient_profile: { id: 10 } } })
    finish(detail); assert.equal(await pending, false)
    assert.equal(page.data.cycle, null); assert.deepEqual(page.data.records, [])
    assert.equal(await page.onShow(), false)
  } finally { h.restore() }
})

test('changing one observation preserves an existing reported time and undisplayed detailed observations', async () => {
  const h = createHarness()
  try {
    setup(h); const page = h.load('care-cycles'); await page._loadPromise
    const known = { ...detail, records: [{ ...detail.records[0], recorded_at: '2026-10-01T00:17:00Z',
      content: { ...detail.records[0].content, attention_rating: 2, is_medication: false } }] }
    h.setRequest(async () => known); await page.openCycle(tap({ id: 21 })); page.selectRecordDate({ detail: { value: '2026-10-01' } })
    assert.equal(page.data.originalTime, '08:17')
    page.onDailyInput({ currentTarget: { dataset: { field: 'focusMinutes' } }, detail: { value: '35' } })
    h.setRequest(async () => { throw new Error('synthetic offline') })
    await page.saveDaily()
    const saved = require('../utils/submission-queue').pendingEntries()[0].payload
    assert.equal(saved.recorded_at, '2026-10-01T00:17:00Z')
    assert.equal(saved.content.attention_rating, 2); assert.equal(saved.content.is_medication, false)
  } finally { h.restore() }
})

test('an ACK handled by background recovery is followed by an actual read, without a false local-persistence message', async () => {
  const h = createHarness()
  try {
    setup(h); const page = h.load('care-cycles'); await page._loadPromise; await page.openCycle(tap({ id: 21 }))
    page.selectRecordDate({ detail: { value: '2026-10-01' } }); page.onDailyInput({ currentTarget: { dataset: { field: 'focusMinutes' } }, detail: { value: '35' } })
    h.setRequest(async () => { throw new Error('synthetic offline') }); await page.saveDaily()
    const q = require('../utils/submission-queue'), original = q.pendingEntries()[0]
    const updated = { ...detail.records[0], record_id: 41, revision: 2, content: { focus_minutes: 35 } }
    h.setRequest(async options => options.method === 'POST' ? { submission_status: 'committed', legacy: false, record_id: 41,
      ...options.data, actor_user_id: 7, revision: 2, content_digest: 'a'.repeat(64) } : { ...detail, records: [updated] })
    assert.equal(await q.syncQueued(original.id), true)
    const before = h.requests.length
    assert.equal(await page.saveDaily(), false)
    assert.deepEqual(h.requests.slice(before).map(row => row.url), ['/care/cycles/21'])
    assert.equal(page.data.pendingId, ''); assert.equal(page.data.records[0].revision, 2)
    assert.doesNotMatch(page.data.statusText, /已保存在本机/)
  } finally { h.restore() }
})
