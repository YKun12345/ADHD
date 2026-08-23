const assert = require('node:assert/strict')

const {
  protectPatientPage,
  registerPatientPage
} = require('../utils/patient-page')

const originalLoadResult = Promise.resolve('loaded')
const lifecycleCalls = []
const customMethod = function (value) {
  return `${this.name}:${value}`
}
const originalOnLoad = function (...args) {
  lifecycleCalls.push(['load', this, args])
  return originalLoadResult
}
const originalOnShow = function (...args) {
  lifecycleCalls.push(['show', this, args])
  return 'shown'
}
const originalDefinition = {
  data: { ready: false },
  customMethod,
  onLoad: originalOnLoad,
  onShow: originalOnShow
}
const originalKeys = Object.keys(originalDefinition)
const validGuardCalls = []
const protectedDefinition = protectPatientPage(originalDefinition, function (...args) {
  validGuardCalls.push([this, args])
  return true
})

assert.notEqual(protectedDefinition, originalDefinition)
assert.deepEqual(Object.keys(originalDefinition), originalKeys)
assert.equal(originalDefinition.onLoad, originalOnLoad)
assert.equal(originalDefinition.onShow, originalOnShow)
assert.equal(protectedDefinition.customMethod, customMethod)
assert.equal(protectedDefinition.data, originalDefinition.data)

const page = { name: 'patient-page' }
const loadArgs = [{ source: 'home' }, 7]
const showArgs = ['resume']
const loadResult = protectedDefinition.onLoad.apply(page, loadArgs)
const showResult = protectedDefinition.onShow.apply(page, showArgs)

assert.equal(loadResult, originalLoadResult)
assert.equal(showResult, 'shown')
assert.equal(page.__patientSessionAllowed, true)
assert.equal(validGuardCalls.length, 2)
assert.deepEqual(lifecycleCalls, [
  ['load', page, loadArgs],
  ['show', page, showArgs]
])

let expiringGuardCalls = 0
let expiringShowCalls = 0
const expiringPage = {}
const expiringDefinition = protectPatientPage({
  onShow() {
    expiringShowCalls += 1
    return expiringShowCalls
  }
}, () => {
  expiringGuardCalls += 1
  return expiringGuardCalls < 3
})

assert.equal(expiringDefinition.onLoad.call(expiringPage), undefined)
assert.equal(expiringDefinition.onShow.call(expiringPage), 1)
assert.equal(expiringDefinition.onShow.call(expiringPage), undefined)
assert.equal(expiringDefinition.onShow.call(expiringPage), undefined)
assert.equal(expiringGuardCalls, 3)
assert.equal(expiringShowCalls, 1)
assert.equal(expiringPage.__patientSessionAllowed, false)

let rejectedGuardCalls = 0
let rejectedLoadCalls = 0
let rejectedShowCalls = 0
const rejectedPage = {}
const rejectedDefinition = protectPatientPage({
  onLoad() {
    rejectedLoadCalls += 1
  },
  onShow() {
    rejectedShowCalls += 1
  }
}, () => {
  rejectedGuardCalls += 1
  return false
})

assert.equal(rejectedDefinition.onLoad.call(rejectedPage), undefined)
assert.equal(rejectedDefinition.onShow.call(rejectedPage), undefined)
assert.equal(rejectedGuardCalls, 1)
assert.equal(rejectedLoadCalls, 0)
assert.equal(rejectedShowCalls, 0)

const onlyShowArgs = [{ resumed: true }]
let onlyShowGuardCalls = 0
let onlyShowLifecycleCalls = 0
const onlyShowPage = { name: 'show-only' }
const onlyShowDefinition = protectPatientPage({
  onShow(...args) {
    onlyShowLifecycleCalls += 1
    assert.equal(this, onlyShowPage)
    assert.deepEqual(args, onlyShowArgs)
    return 'show-only-result'
  }
}, () => {
  onlyShowGuardCalls += 1
  return true
})

assert.equal(
  onlyShowDefinition.onShow.apply(onlyShowPage, onlyShowArgs),
  'show-only-result'
)
assert.equal(onlyShowGuardCalls, 1)
assert.equal(onlyShowLifecycleCalls, 1)

let emptyGuardCalls = 0
const emptyPage = {}
const emptyDefinition = protectPatientPage({ customMethod }, () => {
  emptyGuardCalls += 1
  return true
})

assert.equal(emptyDefinition.customMethod, customMethod)
assert.equal(emptyDefinition.onLoad.call(emptyPage), undefined)
assert.equal(emptyDefinition.onShow.call(emptyPage), undefined)
assert.equal(emptyGuardCalls, 2)

const previousPage = global.Page
let registeredDefinition
global.Page = (definition) => {
  registeredDefinition = definition
}
try {
  const definition = { customMethod }
  registerPatientPage(definition)
  assert.notEqual(registeredDefinition, definition)
  assert.equal(registeredDefinition.customMethod, customMethod)
  assert.equal(typeof registeredDefinition.onLoad, 'function')
  assert.equal(typeof registeredDefinition.onShow, 'function')
  assert.deepEqual(definition, { customMethod })
} finally {
  if (previousPage === undefined) delete global.Page
  else global.Page = previousPage
}

console.log('患者页面统一包装器测试全部通过')
