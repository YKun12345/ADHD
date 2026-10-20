const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const context = () => ({ assessment_id: 2, patient_id: 8, responsible_doctor_id: 7, assessment_version: 3,
  input_digest: 'd'.repeat(64), review_context: 'synthetic-original-review-context', review_context_digest: 'e'.repeat(64),
  background: { visibility: 'withheld', fields: {} }, items: [{ assessment_item_id: 3, key: 'flanker', execution_status: 'submitted', acceptance_status: 'pending_review' }],
  attempts: [{ attempt_id: 4, assessment_item_id: 3, execution_status: 'submitted', actor_user_id: 9, performer_patient_id: 8 }],
  submissions: [{ submission_id: 'original-submission', assessment_item_id: 3, attempt_id: 4, quality_status: 'limited', quality_reasons: ['execution_interrupted'],
    quality_rule_version: 'actual-rule-v1', acceptance_status: 'pending_review', server_result: { kind: 'cognitive', result_json: { raw_result: { accuracy: 75 } } } }],
  allowed_categories: ['evidence_review', 'screening_opinion'], ai_draft_status: 'not_provided' })
test('doctor page reads actual complete inputs, keeps quality separate and requires explicit per-original decisions', async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    h.setRequest(async options => options.url.endsWith('/review-context') ? context() : { items: [] })
    const page = h.load('doctor-review', { query: { patient_id: '8', assessment_id: '2' } }); await page._loadPromise
    assert.equal(page.data.submissions[0].qualityLabel, '有局限')
    assert.equal(page.data.submissions[0].decision, '')
    assert.match(page.data.submissions[0].originalText, /75/)
    assert.match(page.data.backgroundText, /未共享/)
    assert.equal(await page.saveDraft(), false)
    assert.equal(h.requests.filter(row => row.method === 'POST').length, 0)
    page.onHide(); assert.deepEqual(page.data.submissions, []); assert.equal(page.data.body, '')
  } finally { h.restore() }
})
test('same-account hidden response and switched-account old page cannot restore evidence or submit using a new account', async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    let finish, reads = 0
    h.setRequest(async options => options.url.endsWith('/review-context')
      ? ++reads === 1 ? new Promise(resolve => { finish = resolve }) : context() : { items: [] })
    const page = h.load('doctor-review', { query: { patient_id: '8', assessment_id: '2' } }); await h.flush()
    page.onHide(); await page.onShow(); assert.equal(page.data.submissions.length, 1)
    finish({ ...context(), submissions: [] }); await page._loadPromise
    assert.equal(page.data.submissions.length, 1)
    require('../utils/session-privacy').replacePatientSession({ access_token: 'new-account', user: { id: 11, role: 'researcher' } })
    assert.equal(await page.saveDraft(), false)
    assert.deepEqual(page.data.submissions, [])
    assert.equal(h.requests.filter(row => row.method === 'POST').length, 0)
  } finally { h.restore() }
})
