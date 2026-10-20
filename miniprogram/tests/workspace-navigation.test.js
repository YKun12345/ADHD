const test = require('node:test'), assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
test('role menus map only approved sections and preserve the doctor patient-list destination', () => {
  const nav = require('../utils/workspace-navigation')
  assert.deepEqual(nav.itemsFor('patient').map(row => row.key), ['home','assessments','records','communication','account'])
  assert.deepEqual(nav.itemsFor('researcher').map(row => row.key), ['home','patients','communication','account'])
  assert.equal(nav.sectionUrl('patient','patients'), null)
  assert.equal(nav.sectionUrl('researcher','patients'), '/pages/doctor-home/index?section=patients')
  assert.equal(nav.sectionUrl('patient','javascript:alert(1)'), null)
  assert.deepEqual(nav.itemsFor('admin'), [])
})
test('the assessment workspace reads the actual authorized list and opens only its own returned round', async () => {
  const h = createHarness(), opened = []
  try {
    wx.navigateTo = options => opened.push(options.url)
    h.setRequest(async options => {
      if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 8, display_name: '合成档案' }] }
      if (options.url === '/care/assessments?patient_id=8') return { items: [{ id: 31, patient_id: 8, status: 'active', age_group: 'adult', version: 2 }] }
      throw new Error(options.url)
    })
    const page = h.load('workspace', { query: { section: 'assessments' } }); await page._loadPromise
    assert.equal(page.data.errorText, ''); assert.equal(page.data.assessments[0].id, 31)
    assert.equal(page.openAssessment({ currentTarget: { dataset: { id: 999 } } }), false)
    assert.equal(page.openAssessment({ currentTarget: { dataset: { id: 31 } } }), true)
    assert.deepEqual(opened, ['/pages/assessments/index?patient_id=8&assessment_id=31'])
    page.onHide(); assert.deepEqual(page.data.assessments, []); assert.deepEqual(page.data.profiles, [])
  } finally { h.restore() }
})
test('an unauthorized query profile and an old actor response cannot populate the workspace', async () => {
  const h = createHarness()
  try {
    h.setRequest(async options => {
      if (options.url === '/identity/context') return { accessible_patients: [{ patient_id: 8 }] }
      throw new Error('Unexpected access ' + options.url)
    })
    let page = h.load('workspace', { query: { section: 'records', patient_id: '9' } }); await page._loadPromise
    assert.match(page.data.errorText, /档案|范围/); assert.equal(h.requests.some(row => row.url.includes('patient_id=9')), false)
    let resolveList
    h.setRequest(options => options.url === '/identity/context' ? new Promise(resolve => { resolveList = resolve }) : Promise.reject(new Error(options.url)))
    page = h.load('workspace', { query: { section: 'assessments' } }); await h.flush()
    h.storage.current_user = { id: 90, role: 'researcher' }; h.storage.access_token = 'new-role-token'
    resolveList({ accessible_patients: [{ patient_id: 8 }] }); await page._loadPromise
    assert.deepEqual(page.data.profiles, []); assert.deepEqual(page.data.assessments, [])
    assert.equal(page.openEntry({ currentTarget: { dataset: { key: 'assessment' } } }), false)
  } finally { h.restore() }
})
