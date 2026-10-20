const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const { snapshot } = require('./helpers/assessment-snapshot')
const row = doctor => ({ id: 11, patient_id: 8, assessment_id: 42, submission_id: 'actual-run', kind: 'assessment_quality',
  owner_kind: doctor ? 'doctor' : 'patient_self', responsible_doctor_id: doctor ? 7 : null,
  status: 'open', version: 1, quality_reasons: ['execution_interrupted'],
  response_coverage: { status: 'not_configured' }, expected_response_at: null, allowed_actions: ['read_evidence'] })
const tap = id => ({ currentTarget: { dataset: { id } } })

test('personal attention loads actual owned context and reads the exact evidence reference', async () => {
  const h = createHarness()
  try {
    h.setRequest(async options => options.url === '/identity/context' ? { accessible_patients: [{ patient_id: 8 }] }
      : options.url.endsWith('/evidence') ? { submission_id: 'actual-run', context: { patient_id: 8, assessment_id: 42 },
        server_result: { kind: 'cognitive', legacy: false, result_json: { raw_result: { accuracy: 75 }, trials: [1, 2] } },
        ack: { quality_status: 'limited', acceptance_status: 'not_required' } }
        : { items: [row(false)], service_coverage: { status: 'not_configured' } })
    const page = h.load('care-attention'); await page._loadPromise
    assert.deepEqual(h.requests.map(value => value.url), ['/identity/context', '/care/patient/attention?patient_id=8'])
    assert.match(page.data.items[0].title, /局限|质量/)
    assert.match(page.data.coverageText, /未配置/)
    assert.equal(await page.readEvidence(tap(11)), true)
    assert.equal(h.requests.at(-1).url, '/care/submissions/actual-run/evidence')
    assert.equal(page.data.evidence.qualityLabel, '有局限')
    assert.equal(page.data.evidence.trialCount, 2)
    assert.equal(page.data.evidence.scoreText, '准确率 75%')
  } finally { h.restore() }
})

test('doctor attention uses the actual work queue and refuses another owner in its response', async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    h.setRequest(async () => ({ items: [row(true)] }))
    const page = h.load('care-attention'); await page._loadPromise
    assert.deepEqual(h.requests.map(value => value.url), ['/care/doctor/work_queue'])
    assert.equal(page.data.items.length, 1)
    h.setRequest(async () => ({ items: [{ ...row(true), responsible_doctor_id: 99 }] }))
    await page.reload()
    assert.equal(page.data.items.length, 0)
    assert.match(page.data.errorText, /读取|不一致/)
  } finally { h.restore() }
})

test('a late original evidence read cannot restore A after an actual B account replacement', async () => {
  const h = createHarness()
  try {
    h.setRequest(async options => options.url === '/identity/context' ? { accessible_patients: [{ patient_id: 8 }] } : { items: [row(false)] })
    const page = h.load('care-attention'); await page._loadPromise
    global.getCurrentPages = () => [page]
    let finish
    h.setRequest(() => new Promise(resolve => { finish = resolve }))
    const pending = page.readEvidence(tap(11)); await Promise.resolve()
    require('../utils/session-privacy').replacePatientSession({ access_token: 'new-B', user: { id: 9, role: 'patient', patient_profile: { id: 10 } } })
    finish({ submission_id: 'actual-run', context: { patient_id: 8, assessment_id: 42 }, server_result: { kind: 'cognitive', legacy: false }, ack: {} })
    assert.equal(await pending, false)
    assert.equal(page.data.evidence, null)
    assert.deepEqual(page.data.items, [])
    assert.equal(await page.onShow(), false)
  } finally { h.restore() }
})

test('an attention deep link opens the exact persisted assessment instead of an unrelated list', async () => {
  const h = createHarness()
  try {
    const assessment = snapshot()
    h.setRequest(async options => options.url === '/identity/context' ? { accessible_patients: [{ patient_id: 8 }] }
      : options.url.startsWith('/care/assessment-templates') ? { items: [] }
        : options.url === '/care/assessments/42' ? assessment : { items: [assessment] })
    const page = h.load('assessments', { query: { patient_id: '8', assessment_id: '42' } }); await page._loadPromise
    assert.equal(page.data.assessment && page.data.assessment.id, 42)
    assert.equal(h.requests.at(-1).url, '/care/assessments/42')
  } finally { h.restore() }
})

test('actual configured coverage and original deadline are shown without rewriting them to current version', async () => {
  const h = createHarness()
  try {
    const coverage = { status: 'configured', coverage: { id: 1, doctor_user_id: 7, institution_id: 'synthetic-institution', version: 1,
      timezone: 'Asia/Shanghai', working_periods: [{ weekday: 0, start: '09:00', end: '12:00' }], expected_response_working_minutes: 120,
      approved_process_reference: 'synthetic-reference', escalation_instructions: '合成已批准现实处理说明' } }
    h.setRequest(async options => options.url === '/identity/context' ? { accessible_patients: [{ patient_id: 8 }] }
      : { items: [{ ...row(true), response_coverage: coverage, expected_response_at: '2026-10-19T03:00:00+00:00',
        current_service_coverage: { ...coverage, coverage: { ...coverage.coverage, version: 2, expected_response_working_minutes: 60 } } }] })
    const page = h.load('care-attention'); await page._loadPromise
    assert.match(page.data.items[0].coverageText, /120.*工作分钟/)
    assert.match(page.data.items[0].coverageText, /周一.*09:00.*12:00/)
    assert.match(page.data.items[0].coverageText, /合成已批准现实处理说明/)
    assert.match(page.data.items[0].deadlineText, /2026-10-19 11:00/)
    assert.match(page.data.items[0].currentCoverageText, /版本 2/)
    assert.equal(page.data.items[0].response_coverage.coverage.version, 1)
  } finally { h.restore() }
})

test('a persisted overdue observation shows actual institutional instructions and does not claim resolution or external delivery', async () => {
  const h = createHarness()
  try {
    const original = { ...row(true), responsible_doctor_id: 90, expected_response_at: '2026-10-16T02:00:00+00:00',
      response_coverage: { status: 'configured', coverage: { id: 1, version: 1, institution_id: 'synthetic-institution', doctor_user_id: 90,
        timezone: 'Asia/Shanghai', working_periods: [{ weekday: 4, start: '09:00', end: '17:00' }], expected_response_working_minutes: 60,
        escalation_instructions: '合成机构批准的现实超时处理说明' } }, overdue_observation: { system_principal: 'attention_deadline_monitor',
      original_deadline: '2026-10-16T02:00:00+00:00', observed_at: '2026-10-16T02:01:00+00:00', status: 'requires_institutional_action',
      institutional_instructions: '合成机构批准的现实超时处理说明', external_delivery_status: 'not_configured', human_action: false } }
    h.setRequest(async options => options.url === '/identity/context' ? { accessible_patients: [{ patient_id: 8 }] } : { items: [original] })
    const page = h.load('care-attention'); await page._loadPromise
    assert.equal(page.data.items[0].status, 'open')
    assert.match(page.data.items[0].overdueText, /超过原期望窗口/)
    assert.match(page.data.items[0].overdueText, /合成机构批准的现实超时处理说明/)
    assert.match(page.data.items[0].overdueText, /外部通知未配置/)
    assert.doesNotMatch(page.data.items[0].overdueText, /已解决|已送达/)
  } finally { h.restore() }
})
