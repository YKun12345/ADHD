const assert = require('node:assert/strict')

const {
  hasValidRoleSession,
  hasValidAnySession,
  getRoleDestination,
  ensureResearcherSession
} = require('../utils/role-session')

const patient = { id: 1, role: 'patient', full_name: '患者甲' }
const researcher = { id: 2, role: 'researcher', subrole: 'normal', full_name: '李医生' }

function reader(values) {
  return (key) => values[key]
}

assert.equal(hasValidRoleSession('patient', reader({ access_token: 'token', current_user: patient })), true)
assert.equal(hasValidRoleSession('researcher', reader({ access_token: 'token', current_user: researcher })), true)
assert.equal(hasValidRoleSession('patient', reader({ access_token: 'token', current_user: researcher })), false)
assert.equal(hasValidRoleSession('researcher', reader({ access_token: 'token', current_user: patient })), false)
assert.equal(hasValidRoleSession('dac', reader({ access_token: 'token', current_user: researcher })), false)
assert.equal(hasValidRoleSession('researcher', reader({ access_token: '', current_user: researcher })), false)
assert.equal(hasValidAnySession(reader({ access_token: 'token', current_user: researcher })), true)
assert.equal(hasValidAnySession(reader({ access_token: 'token', current_user: patient })), true)
assert.equal(hasValidAnySession(reader({ access_token: 'token', current_user: { id: 3, role: 'dac' } })), false)

assert.equal(getRoleDestination(patient), '/pages/home/index')
assert.equal(getRoleDestination(researcher), '/pages/doctor-home/index')
assert.equal(getRoleDestination({ id: 3, role: 'dac' }), '/pages/login/index')
assert.equal(getRoleDestination(null), '/pages/login/index')

const removedKeys = []
const reLaunches = []
assert.equal(ensureResearcherSession({
  readStorage: reader({ access_token: 'patient-token', current_user: patient }),
  removeStorage(key) {
    removedKeys.push(key)
    return true
  },
  setLoggedIn() {
    return true
  },
  getPages() {
    return []
  },
  reLaunch(options) {
    reLaunches.push(options)
  }
}), false)
assert.equal(removedKeys.includes('access_token'), true)
assert.equal(removedKeys.includes('current_user'), true)
assert.equal(removedKeys.includes('patient_dashboard_cache'), true)
assert.equal(reLaunches[0].url, '/pages/login/index')

console.log('患者与研究者角色会话测试全部通过')
