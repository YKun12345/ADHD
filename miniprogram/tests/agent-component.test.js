const { test } = require('node:test'), assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const response = pid => ({ actor_user_id: 7, patient_id: pid, mode: 'rules', items: [{ id: pid, actor_user_id: 7, patient_id: pid,
  status: 'available', title: '实际下一步', reason: '已保存材料', action_digest: 'a'.repeat(64), target: { page_key: 'assessments', params: { patient_id: pid } } }] })
function component(pid) {
  let definition; global.Component = value => { definition = value }
  const file = require.resolve('../components/agent-actions/index'); delete require.cache[file]; require(file)
  return { definition, view: { ...definition.methods, data: { ...structuredClone(definition.data), patientId: pid },
    setData(values) { Object.assign(this.data, values) } } }
}
test('an in-flight previous-profile response cannot replace actions after the actual component property changes', async () => {
  const h = createHarness()
  try {
    let release
    h.setRequest(options => options.url.endsWith('patient_id=8') ? new Promise(resolve => { release = resolve }) : Promise.resolve(response(9)))
    const { view, definition } = component(8), load = definition.lifetimes.attached.call(view)
    view.data.patientId = 9; definition.properties.patientId.observer.call(view)
    release(response(8)); await load; await h.flush()
    assert.equal(view.data.selectedPatientId, 9)
    assert.ok(view.data.items.every(row => row.patient_id === 9))
    definition.pageLifetimes.hide.call(view); assert.deepEqual(view.data.items, [])
  } finally { h.restore() }
})

test('doctor home loads authorized profiles through the actual doctor list endpoint before requesting next actions', async () => {
  const h = createHarness()
  try {
    h.storage.current_user = { id: 7, role: 'researcher' }
    const requests = []
    h.setRequest(options => {
      requests.push(options.url)
      if (options.url === '/doctor/my_patients') return Promise.resolve({ items: [{ patient_id: 8, patient_name: '合成用户' }] })
      if (options.url === '/agent/actions?patient_id=8') return Promise.resolve(response(8))
      return Promise.reject(new Error(`不存在的业务地址：${options.url}`))
    })
    const { view, definition } = component(0)
    assert.equal(await definition.lifetimes.attached.call(view), true, view.data.errorText)
    assert.deepEqual(requests, ['/doctor/my_patients', '/agent/actions?patient_id=8'])
    assert.equal(view.data.selectedPatientId, 8)
    assert.equal(view.data.profiles[0].label, '合成用户')
    assert.equal(view.data.items.length, 1)
    definition.pageLifetimes.hide.call(view)
  } finally { h.restore() }
})
