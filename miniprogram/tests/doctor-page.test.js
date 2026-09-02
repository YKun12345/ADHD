const assert = require('node:assert/strict')

const {
  protectDoctorPage,
  registerDoctorPage
} = require('../utils/doctor-page')

let lifecycleCalls = 0
const definition = protectDoctorPage({
  data: { ready: false },
  onLoad(value) {
    lifecycleCalls += 1
    return value
  }
}, () => true)

const allowedPage = {}
assert.equal(definition.onLoad.call(allowedPage, 'doctor-ready'), 'doctor-ready')
assert.equal(lifecycleCalls, 1)
assert.equal(allowedPage.__doctorSessionAllowed, true)

let deniedLifecycleCalls = 0
const deniedDefinition = protectDoctorPage({
  onLoad() {
    deniedLifecycleCalls += 1
  },
  onShow() {
    deniedLifecycleCalls += 1
  }
}, () => false)
const deniedPage = {}
assert.equal(deniedDefinition.onLoad.call(deniedPage), undefined)
assert.equal(deniedDefinition.onShow.call(deniedPage), undefined)
assert.equal(deniedLifecycleCalls, 0)

const previousPage = global.Page
let registeredDefinition
global.Page = (value) => {
  registeredDefinition = value
}
try {
  registerDoctorPage({ doctorMethod() {} })
  assert.equal(typeof registeredDefinition.onLoad, 'function')
  assert.equal(typeof registeredDefinition.onShow, 'function')
  assert.equal(typeof registeredDefinition.doctorMethod, 'function')
} finally {
  if (previousPage === undefined) delete global.Page
  else global.Page = previousPage
}

console.log('医生页面角色守卫测试全部通过')
