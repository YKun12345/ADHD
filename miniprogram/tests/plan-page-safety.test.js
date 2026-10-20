const { test } = require('node:test'), assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
for (const role of ['patient', 'researcher']) test(`${role} plan page cannot restore a hidden response or operate using a changed actor`, async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = role
    delete require.cache[require.resolve('../utils/plan-page')]
    let release; h.setRequest(() => new Promise(resolve => { release = resolve }))
    const page = h.load(role === 'patient' ? 'patient-plan' : 'doctor-plan', { query: { patient_id: '8', assessment_id: '2' } })
    page.onHide(); release({ items: [{ id: 15, patient_id: 8, assessment_id: 2, status: 'active', versions: [{ id: 25, patient_id: 8,
      assessment_id: 2, title: '旧资料', instructions: '敏感计划正文', version: 1 }], tasks: [], acknowledgements: [] }] }); await page._loadPromise
    assert.equal(page.data.plan, null); assert.deepEqual(page.data.versions, [])
    require('../utils/session-privacy').replacePatientSession({ access_token: 'synthetic-new-account', user: { id: 9, role, patient_profile: { id: 10 } } })
    const before = h.requests.length
    assert.equal(await page.onShow(), false); assert.equal(await page.publish(), false); assert.equal(await page.receive(), false)
    assert.equal(h.requests.length, before); assert.equal(page.data.plan, null)
  } finally { h.restore() }
})
