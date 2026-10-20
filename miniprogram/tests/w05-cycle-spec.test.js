// Independent W05 immutable queue ACK and actual page observations.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const tap = dataset => ({ currentTarget: { dataset } })
const cycle = { id: 21, patient_id: 8, client_cycle_id: 'create-spec', cycle_type: 'self', start_date: '2026-10-01', end_date: '2026-10-14',
  calendar_timezone: 'Asia/Shanghai', responsible_doctor_id: null, plan_version_id: null, actor_user_id: 7, allowed_actions: ['create_daily'] }
const detail = { ...cycle, summary: { as_of_date: '2026-10-15', completed_count: 1, due_count: 14, missing_dates: ['2026-10-02'] },
  records: [{ record_id: 44, patient_id: 8, cycle_id: 21, record_date: '2026-10-01', revision: 1, recorded_at: null,
    content: { focus_minutes: 0, is_medication: false }, submitted_at: '2026-10-02T01:00:00Z', is_backfill: true }] }
const daily = id => ({ id, kind: 'cycle_daily', route: '/care/daily-records', payload: { patient_id: 8, cycle_id: 21,
  client_submission_id: id, record_date: '2026-10-01', expected_revision: 0, recorded_at: null, content: { focus_minutes: 0, note: '合成原件' } } })
const ack = body => ({ ...body, record_id: 55, revision: body.expected_revision + 1, actor_user_id: 7,
  submission_status: 'committed', legacy: false, content_digest: 'a'.repeat(64) })
const setup = h => h.setRequest(async options => options.url === '/identity/context' ? { accessible_patients: [{ patient_id: 8 }] }
  : options.url.includes('?patient_id=') ? { items: [cycle], as_of_date: '2026-10-15', calendar_timezone: 'Asia/Shanghai' } : detail)

for (const [label, mutate] of [
  ['different daily content', value => ({ ...value, content: { focus_minutes: 999, note: '不是队列原件' } })],
  ['different original reported time', value => ({ ...value, recorded_at: '2000-01-01T00:00:00Z' })],
  ['different original actor', value => ({ ...value, actor_user_id: 999 })],
  ['different expected revision', value => ({ ...value, expected_revision: 99 })]
]) test(`daily ACK with ${label} must retain the immutable pending original`, async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'), entry = daily('daily-spec')
    q.enqueue(entry)
    h.setRequest(async options => mutate(ack(options.data)))
    assert.equal(await q.syncQueued(entry.id), false)
    assert.deepEqual(q.pendingEntries()[0].payload, entry.payload)
    assert.equal(q.pendingEntries()[0].status, 'ack_unverified')
  } finally { h.restore() }
})

test('cycle creation ACK for a different original actor must retain pending creation', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue')
    const entry = { id: 'create-spec', kind: 'cycle_create', route: '/care/cycles', payload: {
      client_cycle_id: 'create-spec', patient_id: 8, cycle_type: 'self', start_date: '2026-10-01', end_date: '2026-10-14' } }
    q.enqueue(entry)
    h.setRequest(async () => ({ ...cycle, actor_user_id: 999 }))
    assert.equal(await q.syncQueued(entry.id), false)
    assert.deepEqual(q.pendingEntries()[0].payload,entry.payload)
  } finally { h.restore() }
})

test('cycle queue rejects alternate URLs before transmitting and fixed-query recovery only removes its matching day', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue')
    assert.throws(() => q.enqueue({ ...daily('wrong-route'), route: '/patient/submit_tracking' }))
    q.enqueue(daily('daily-one'))
    const second = daily('daily-two'); second.payload.record_date = '2026-10-02'; q.enqueue(second)
    h.setRequest(async options => {
      assert.equal(options.url,'/care/daily-records/daily-two')
      return ack(second.payload)
    })
    assert.equal(await q.queryQueuedStatus('daily-two'),true)
    assert.deepEqual(q.pendingEntries().map(row => row.id),['daily-one'])
  } finally { h.restore() }
})

test('page actually saves mood sleep zero and unknown time without changing the existing detailed observation', async () => {
  const h = createHarness()
  try {
    setup(h)
    const page = h.load('care-cycles'); await page._loadPromise; await page.openCycle(tap({ id: 21 }))
    page.selectRecordDate({ detail: { value: '2026-10-01' } })
    for (const [field,value] of [['moodTag','平静'],['sleepQuality','睡眠不足'],['note','实际补录']]) {
      page.onDailyInput({ currentTarget: { dataset: { field } }, detail: { value } })
    }
    h.setRequest(async () => { throw new Error('synthetic offline') })
    assert.equal(await page.saveDaily(),false)
    const body = require('../utils/submission-queue').pendingEntries()[0].payload
    assert.deepEqual(body.content,{ focus_minutes: 0, is_medication: false, mood_tag: '平静', sleep_quality: '睡眠不足', note: '实际补录' })
    assert.equal(body.expected_revision,1); assert.equal(body.recorded_at,null)
  } finally { h.restore() }
})

test('real B login during daily upload prevents old ACK from clearing new B queue evidence', async () => {
  const h = createHarness()
  try {
    const q = require('../utils/submission-queue'), original = daily('daily-a'); q.enqueue(original)
    let finish
    h.setRequest(() => new Promise(resolve => { finish = resolve }))
    const upload = q.syncQueued(original.id); await Promise.resolve()
    require('../utils/session-privacy').replacePatientSession({ access_token: 'synthetic-cycle-B', user: { id: 9, role: 'patient', patient_profile: { id: 10 } } })
    const second = daily('daily-b'); second.payload.patient_id = 10; second.payload.cycle_id = 100; q.enqueue(second)
    finish(ack(original.payload)); assert.equal(await upload,false)
    assert.deepEqual(q.pendingEntries().map(row => row.id),['daily-b'])
    assert.equal(q.pendingEntries()[0].payload.patient_id,10)
  } finally { h.restore() }
})
