const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

const item = () => ({ id: 11, patient_id: 8, assessment_id: 42, submission_id: 'quality-original',
  kind: 'assessment_quality', owner_kind: 'patient_self', responsible_doctor_id: null,
  status: 'open', quality_reasons: ['execution_interrupted'], allowed_actions: ['read_evidence'] })
const evidence = () => ({ submission_id: 'quality-original', context: { patient_id: 8, assessment_id: 42 },
  server_result: { kind: 'scale', legacy: false, total_score: 9 },
  ack: { quality_status: 'limited', acceptance_status: 'not_required' } })
const tap = () => ({ currentTarget: { dataset: { id: 11 } } })

async function loadedPage(h) {
  h.setRequest(async options => options.url === '/identity/context'
    ? { accessible_patients: [{ patient_id: 8 }] } : { items: [item()] })
  const page = h.load('care-attention')
  await page._loadPromise
  return page
}

test('refresh and a visible evidence action settle without leaving attention permanently loading', async () => {
  const h = createHarness()
  try {
    const page = await loadedPage(h)
    let finishList
    h.setRequest(async options => options.url === '/identity/context'
      ? { accessible_patients: [{ patient_id: 8 }] }
      : options.url.endsWith('/evidence') ? evidence()
        : new Promise(resolve => { finishList = resolve }))
    const refreshing = page.reload()
    await h.flush()
    assert.equal(page.data.loading, true)
    assert.equal(typeof finishList, 'function')
    const reading = await page.readEvidence(tap())
    finishList({ items: [item()] })
    await refreshing
    console.log({ case: 'refresh_then_visible_evidence', reading,
      loading: page.data.loading, busy: page.data.busy, items: page.data.items.length })
    assert.equal(page.data.loading, false, 'all requests settled; the refresh control must become usable')
    assert.equal(page.data.busy, false)
  } finally { h.restore() }
})

test('late list data cannot restore the previous account after a real session replacement', async () => {
  const h = createHarness()
  const originalPages = global.getCurrentPages
  try {
    const page = await loadedPage(h)
    global.getCurrentPages = () => [page]
    let finish
    h.setRequest(async options => options.url === '/identity/context'
      ? { accessible_patients: [{ patient_id: 8 }] }
      : new Promise(resolve => { finish = resolve }))
    const pending = page.reload()
    await h.flush()
    require('../utils/session-privacy').replacePatientSession({ access_token: 'quality-account-B',
      user: { id: 19, role: 'patient', patient_profile: { id: 20 } } })
    finish({ items: [item()] })
    assert.equal(await pending, false)
    assert.deepEqual(page.data.items, [])
    assert.equal(page.data.evidence, null)
    assert.equal(page.data.loading, false)
  } finally { global.getCurrentPages = originalPages; h.restore() }
})

test('permission denial and integrity failure withhold evidence and leave refresh usable', async () => {
  for (const statusCode of [403, 503]) {
    const h = createHarness()
    try {
      const page = await loadedPage(h)
      h.setRequest(async () => { throw { statusCode } })
      assert.equal(await page.readEvidence(tap()), false)
      assert.equal(page.data.evidence, null)
      assert.equal(page.data.busy, false)
      assert.ok(page.data.errorText)
      h.setRequest(async options => options.url === '/identity/context'
        ? { accessible_patients: [{ patient_id: 8 }] } : { items: [] })
      assert.equal(await page.reload(), true)
      assert.deepEqual(page.data.items, [])
      assert.equal(page.data.errorText, '')
    } finally { h.restore() }
  }
})
