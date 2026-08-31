const assert = require('node:assert/strict')

const {
  SESSION_KEYS,
  PATIENT_DATA_KEYS,
  hasValidPatientSession,
  summarizePatientData,
  clearPatientData,
  endPatientSession,
  ensurePatientSession,
  getPatientDataRevision,
  advancePatientDataRevision,
  capturePatientDataLease,
  isPatientDataLeaseCurrent,
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
} = require('../utils/session-privacy')

const EMPTY_SUMMARY = {
  draftCount: 0,
  resultCount: 0,
  trackingDayCount: 0,
  pendingCount: 0,
  totalLocalItems: 0
}

function readFrom(values) {
  return (key) => values[key]
}

function captureCall(operation) {
  try {
    return { value: operation(), error: undefined }
  } catch (error) {
    return { value: undefined, error }
  }
}

function throwingRemover(attemptedKeys) {
  return (key) => {
    attemptedKeys.push(key)
    if (key === 'scale_draft_asrs' || key === 'access_token') {
      throw new Error(`failed to remove ${key}`)
    }
  }
}

assert.deepEqual(SESSION_KEYS, [
  'access_token',
  'current_user'
])

assert.deepEqual(PATIENT_DATA_KEYS, [
  'patient_dashboard_cache',
  'scale_draft_asrs',
  'scale_draft_snap_iv',
  'scale_latest_result',
  'cognitive_latest_results',
  'pending_cognitive_result',
  'pending_stroop_result',
  'pending_simple_reaction_result',
  'pending_trail_result',
  'pending_flanker_result',
  'pending_nback_result',
  'pending_digit_result',
  'cognitive_battery_state',
  'tracking_local_logs',
  'tracking_pending_logs'
])
assert.equal(PATIENT_DATA_KEYS.includes('api_base_url'), false)

const initialRevision = getPatientDataRevision()
const initialLeaseStorage = {
  access_token: 'lease-token'
}
const initialLease = capturePatientSessionLease(readFrom(initialLeaseStorage))
assert.equal(isPatientSessionLeaseCurrent(
  initialLease,
  readFrom(initialLeaseStorage)
), true)
assert.equal(advancePatientDataRevision(), initialRevision + 1)
assert.equal(getPatientDataRevision(), initialRevision + 1)
assert.equal(isPatientSessionLeaseCurrent(
  initialLease,
  readFrom(initialLeaseStorage)
), false)
const currentLease = capturePatientSessionLease(readFrom(initialLeaseStorage))
initialLeaseStorage.access_token = 'replacement-token'
assert.equal(isPatientSessionLeaseCurrent(
  currentLease,
  readFrom(initialLeaseStorage)
), false)
assert.equal(isPatientSessionLeaseCurrent(currentLease, () => {
  throw new Error('storage unavailable')
}), false)

const unreadableLease = capturePatientSessionLease(() => {
  throw new Error('storage unavailable')
})
assert.equal(isPatientSessionLeaseCurrent(unreadableLease, () => {
  throw new Error('storage unavailable')
}), false)
assert.equal(isPatientSessionLeaseCurrent(
  capturePatientSessionLease(readFrom({ access_token: '   ' })),
  readFrom({ access_token: '   ' })
), false)
assert.equal(isPatientSessionLeaseCurrent(
  capturePatientSessionLease(readFrom({})),
  readFrom({})
), false)

const dataLeaseStorage = {
  api_base_url: 'https://api-a.example.com/api/v1'
}
const dataLease = capturePatientDataLease(readFrom(dataLeaseStorage))
assert.equal(isPatientDataLeaseCurrent(
  dataLease,
  readFrom(dataLeaseStorage)
), true)
dataLeaseStorage.api_base_url = 'https://api-b.example.com/api/v1'
assert.equal(isPatientDataLeaseCurrent(
  dataLease,
  readFrom(dataLeaseStorage)
), false)
assert.equal(isPatientDataLeaseCurrent(dataLease, () => {
  throw new Error('storage unavailable')
}), false)

const originSessionStorage = {
  access_token: 'origin-token',
  api_base_url: 'https://api-a.example.com/api/v1'
}
const originSessionLease = capturePatientSessionLease(
  readFrom(originSessionStorage)
)
originSessionStorage.api_base_url = 'https://api-b.example.com/api/v1'
assert.equal(isPatientSessionLeaseCurrent(
  originSessionLease,
  readFrom(originSessionStorage)
), false)

assert.equal(hasValidPatientSession(readFrom({
  access_token: '  patient-token  ',
  current_user: {
    id: 7,
    email: 'adult@example.com',
    full_name: 'Adult Patient',
    role: 'patient',
    patient_profile: { patient_type: 'adult' }
  }
})), true)
assert.equal(hasValidPatientSession(readFrom({
  access_token: 'child-token',
  current_user: {
    id: 8,
    email: 'child@example.com',
    full_name: 'Child Patient',
    role: 'patient',
    patient_profile: { patient_type: 'child' }
  }
})), true)

for (const invalidStorage of [
  {},
  { access_token: '', current_user: {} },
  { access_token: '   ', current_user: {} },
  { access_token: 123, current_user: {} },
  { access_token: 'token' },
  { access_token: 'token', current_user: null },
  { access_token: 'token', current_user: {} },
  { access_token: 'token', current_user: { foo: 1 } },
  { access_token: 'token', current_user: { nickname: '   ' } },
  { access_token: 'token', current_user: { profile: { nickname: '' } } },
  { access_token: 'token', current_user: { id: 7 } },
  { access_token: 'token', current_user: { id: 0, role: 'patient' } },
  { access_token: 'token', current_user: { id: 7, role: 'doctor' } },
  { access_token: 'token', current_user: { id: 7, role: 'researcher' } },
  { access_token: 'token', current_user: [] },
  { access_token: 'token', current_user: 'patient' }
]) {
  assert.equal(hasValidPatientSession(readFrom(invalidStorage)), false)
}
assert.equal(hasValidPatientSession(() => {
  throw new Error('storage unavailable')
}), false)

assert.deepEqual(summarizePatientData(readFrom({
  scale_draft_asrs: { answers: [0] },
  scale_draft_snap_iv: [false],
  scale_latest_result: { score: 0 },
  cognitive_latest_results: {
    stroop: { score: 0 },
    gonogo: [false],
    empty: {}
  },
  tracking_local_logs: [
    { date: '2026-08-23' },
    null,
    [],
    { entries: [0] }
  ],
  pending_cognitive_result: { score: 0 },
  pending_stroop_result: [false],
  tracking_pending_logs: {
    monday: { duration: 0 },
    tuesday: ' queued ',
    blank: ' ',
    empty: {}
  }
})), {
  draftCount: 2,
  resultCount: 3,
  trackingDayCount: 2,
  pendingCount: 4,
  totalLocalItems: 11
})

assert.deepEqual(summarizePatientData(readFrom({
  cognitive_latest_results: [{ score: 1 }, null, {}, 0, ' '],
  tracking_local_logs: { not: 'an array' },
  tracking_pending_logs: [{ id: 1 }, '', false]
})), {
  draftCount: 0,
  resultCount: 0,
  trackingDayCount: 0,
  pendingCount: 0,
  totalLocalItems: 0
})

assert.deepEqual(summarizePatientData(readFrom({
  scale_draft_asrs: '',
  scale_draft_snap_iv: [],
  scale_latest_result: {},
  cognitive_latest_results: 'malformed',
  tracking_local_logs: { malformed: true },
  pending_cognitive_result: null,
  pending_stroop_result: {},
  tracking_pending_logs: 42
})), EMPTY_SUMMARY)
assert.deepEqual(summarizePatientData(() => {
  throw new Error('storage unavailable')
}), EMPTY_SUMMARY)

const clearedKeys = []
const revisionBeforeClear = getPatientDataRevision()
const clearResult = clearPatientData((key) => clearedKeys.push(key))
assert.deepEqual(clearedKeys, PATIENT_DATA_KEYS)
assert.deepEqual(clearResult, { ok: true, failedKeys: [] })
assert.equal(getPatientDataRevision(), revisionBeforeClear + 1)
assert.equal(clearedKeys.includes('access_token'), false)
assert.equal(clearedKeys.includes('current_user'), false)
assert.equal(clearedKeys.includes('api_base_url'), false)

const fullStorage = {
  api_base_url: 'http://192.168.1.8:8000/api/v1',
  access_token: 'patient-token',
  current_user: { id: 7 },
  ...Object.fromEntries(PATIENT_DATA_KEYS.map((key) => [key, { saved: true }]))
}
const fullRemovedKeys = []
const fullLoginStates = []
const revisionBeforeEnd = getPatientDataRevision()
const fullEndResult = endPatientSession({
  removeStorage(key) {
    fullRemovedKeys.push(key)
    delete fullStorage[key]
  },
  setLoggedIn(value) {
    fullLoginStates.push(value)
  }
})
assert.deepEqual(fullRemovedKeys, [...PATIENT_DATA_KEYS, ...SESSION_KEYS])
assert.deepEqual(fullEndResult, {
  ok: true,
  failedKeys: [],
  failedPageCount: 0
})
assert.equal(getPatientDataRevision(), revisionBeforeEnd + 1)
assert.deepEqual(fullLoginStates, [false])
assert.deepEqual(fullStorage, {
  api_base_url: 'http://192.168.1.8:8000/api/v1'
})

let endedHookCalls = 0
let secondEndedHookCalls = 0
const scrubbedPage = {
  __patientSessionAllowed: true,
  data: {
    patientName: 'Sensitive Patient',
    score: 19,
    answers: [1, 2, 3],
    latestResult: { score: 19 },
    active: true
  },
  setData(changes) {
    Object.assign(this.data, changes)
  },
  onPatientSessionEnded() {
    endedHookCalls += 1
  }
}
const secondScrubbedPage = {
  __patientSessionAllowed: true,
  data: {
    acting: true,
    model: { patientId: 7 }
  },
  setData(changes) {
    Object.assign(this.data, changes)
  },
  onPatientSessionEnded() {
    secondEndedHookCalls += 1
    this.setData({ acting: true })
  }
}
const scrubbedEndResult = endPatientSession({
  removeStorage() {},
  setLoggedIn() {},
  getPages() {
    return [scrubbedPage, secondScrubbedPage]
  }
})
assert.deepEqual(scrubbedEndResult, {
  ok: true,
  failedKeys: [],
  failedPageCount: 0
})
assert.equal(scrubbedPage.__patientSessionAllowed, false)
assert.equal(endedHookCalls, 1)
assert.equal(secondScrubbedPage.__patientSessionAllowed, false)
assert.equal(secondEndedHookCalls, 1)
assert.deepEqual(secondScrubbedPage.data, {
  acting: true,
  model: null
})
assert.deepEqual(scrubbedPage.data, {
  patientName: '',
  score: 0,
  answers: [],
  latestResult: null,
  active: false
})

const fallbackScrubbedPage = {
  data: {
    patientName: 'First patient',
    report: { secret: 'private' },
    answers: [1, 2],
    active: true
  },
  setData() {
    throw new Error('setData failed')
  }
}
const failedPageEndResult = endPatientSession({
  removeStorage() {},
  setLoggedIn() {},
  getPages() {
    return [fallbackScrubbedPage, {
      data: { patientName: 'Second patient' },
      setData(changes) {
        Object.assign(this.data, changes)
      },
      onPatientSessionEnded() {
        throw new Error('hook failed')
      }
    }]
  }
})
assert.deepEqual(failedPageEndResult, {
  ok: false,
  failedKeys: [],
  failedPageCount: 2
})
assert.deepEqual(fallbackScrubbedPage.data, {
  patientName: '',
  report: null,
  answers: [],
  active: false
})

const failedGetPagesEndResult = endPatientSession({
  removeStorage() {},
  setLoggedIn() {},
  getPages() {
    throw new Error('page stack unavailable')
  }
})
assert.deepEqual(failedGetPagesEndResult, {
  ok: false,
  failedKeys: [],
  failedPageCount: 1
})

const failedAppStateEndResult = endPatientSession({
  removeStorage() {},
  setLoggedIn() {
    throw new Error('app state unavailable')
  },
  getPages() {
    return []
  }
})
assert.deepEqual(failedAppStateEndResult, {
  ok: false,
  failedKeys: [],
  failedPageCount: 0
})

const defaultEndStorage = {
  api_base_url: 'https://api.example.com/api/v1',
  access_token: 'patient-token',
  current_user: { id: 70 },
  ...Object.fromEntries(PATIENT_DATA_KEYS.map((key) => [key, { saved: true }]))
}
const defaultEndRemovedKeys = []
const defaultEndApp = {
  globalData: {
    isLoggedIn: true,
    userInfo: defaultEndStorage.current_user
  }
}
const previousDefaultEndWx = global.wx
const previousDefaultEndGetApp = global.getApp
global.wx = {
  removeStorageSync(key) {
    defaultEndRemovedKeys.push(key)
    delete defaultEndStorage[key]
  }
}
global.getApp = () => defaultEndApp
try {
  endPatientSession()
} finally {
  if (previousDefaultEndWx === undefined) delete global.wx
  else global.wx = previousDefaultEndWx
  if (previousDefaultEndGetApp === undefined) delete global.getApp
  else global.getApp = previousDefaultEndGetApp
}
assert.deepEqual(
  defaultEndRemovedKeys,
  [...PATIENT_DATA_KEYS, ...SESSION_KEYS]
)
assert.deepEqual(defaultEndStorage, {
  api_base_url: 'https://api.example.com/api/v1'
})
assert.equal(defaultEndApp.globalData.isLoggedIn, false)
assert.equal(defaultEndApp.globalData.userInfo, null)

const sessionOnlyStorage = {
  api_base_url: 'https://api.example.com/api/v1',
  access_token: 'patient-token',
  current_user: { id: 8 },
  patient_dashboard_cache: { saved: true }
}
const sessionOnlyRemovedKeys = []
const sessionOnlyLoginStates = []
endPatientSession({
  includePatientData: false,
  removeStorage(key) {
    sessionOnlyRemovedKeys.push(key)
    delete sessionOnlyStorage[key]
  },
  setLoggedIn(value) {
    sessionOnlyLoginStates.push(value)
  }
})
assert.deepEqual(sessionOnlyRemovedKeys, SESSION_KEYS)
assert.deepEqual(sessionOnlyLoginStates, [false])
assert.deepEqual(sessionOnlyStorage, {
  api_base_url: 'https://api.example.com/api/v1',
  patient_dashboard_cache: { saved: true }
})

const validEnsureCalls = {
  removed: [],
  loginStates: [],
  reLaunches: []
}
assert.equal(ensurePatientSession({
  readStorage: readFrom({
    access_token: 'valid-token',
    current_user: { id: 9, role: 'patient' }
  }),
  removeStorage(key) {
    validEnsureCalls.removed.push(key)
  },
  setLoggedIn(value) {
    validEnsureCalls.loginStates.push(value)
  },
  reLaunch(options) {
    validEnsureCalls.reLaunches.push(options)
  }
}), true)
assert.deepEqual(validEnsureCalls, {
  removed: [],
  loginStates: [],
  reLaunches: []
})

const invalidEnsureStorage = {
  api_base_url: 'http://192.168.1.9:8000/api/v1',
  access_token: 'orphan-token',
  patient_dashboard_cache: { saved: true }
}
const invalidEnsureCalls = {
  removed: [],
  loginStates: [],
  reLaunches: []
}
assert.equal(ensurePatientSession({
  readStorage: readFrom(invalidEnsureStorage),
  removeStorage(key) {
    invalidEnsureCalls.removed.push(key)
    delete invalidEnsureStorage[key]
  },
  setLoggedIn(value) {
    invalidEnsureCalls.loginStates.push(value)
  },
  reLaunch(options) {
    invalidEnsureCalls.reLaunches.push(options)
  }
}), false)
assert.deepEqual(
  invalidEnsureCalls.removed,
  [...PATIENT_DATA_KEYS, ...SESSION_KEYS]
)
assert.deepEqual(invalidEnsureCalls.loginStates, [false])
assert.equal(invalidEnsureCalls.reLaunches.length, 1)
assert.equal(invalidEnsureCalls.reLaunches[0].url, '/pages/login/index')
assert.equal(typeof invalidEnsureCalls.reLaunches[0].success, 'function')
assert.equal(typeof invalidEnsureCalls.reLaunches[0].fail, 'function')
assert.deepEqual(invalidEnsureStorage, {
  api_base_url: 'http://192.168.1.9:8000/api/v1'
})

const invalidOptOutStorage = {
  api_base_url: 'https://api.example.com/api/v1',
  access_token: 'orphan-token',
  ...Object.fromEntries(PATIENT_DATA_KEYS.map((key) => [key, { saved: true }]))
}
const invalidOptOutCalls = {
  removed: [],
  loginStates: [],
  reLaunches: []
}
const invalidOptOutResult = ensurePatientSession({
  includePatientData: false,
  readStorage: readFrom(invalidOptOutStorage),
  removeStorage(key) {
    invalidOptOutCalls.removed.push(key)
    delete invalidOptOutStorage[key]
  },
  setLoggedIn(value) {
    invalidOptOutCalls.loginStates.push(value)
  },
  reLaunch(options) {
    invalidOptOutCalls.reLaunches.push(options)
  }
})
assert.equal(invalidOptOutResult, false)
assert.deepEqual(
  invalidOptOutCalls.removed,
  [...PATIENT_DATA_KEYS, ...SESSION_KEYS]
)
assert.deepEqual(invalidOptOutCalls.loginStates, [false])
assert.equal(invalidOptOutCalls.reLaunches.length, 1)
assert.equal(invalidOptOutCalls.reLaunches[0].url, '/pages/login/index')
assert.equal(typeof invalidOptOutCalls.reLaunches[0].success, 'function')
assert.equal(typeof invalidOptOutCalls.reLaunches[0].fail, 'function')
assert.deepEqual(invalidOptOutStorage, {
  api_base_url: 'https://api.example.com/api/v1'
})

const resilientClearAttempts = []
const resilientClearCall = captureCall(() => {
  return clearPatientData(throwingRemover(resilientClearAttempts))
})

const resilientEndAttempts = []
const resilientEndLoginStates = []
const resilientEndCall = captureCall(() => {
  return endPatientSession({
    removeStorage: throwingRemover(resilientEndAttempts),
    setLoggedIn(value) {
      resilientEndLoginStates.push(value)
    }
  })
})

const resilientEnsureAttempts = []
const resilientEnsureLoginStates = []
const resilientEnsureReLaunches = []
const resilientEnsureCall = captureCall(() => ensurePatientSession({
  readStorage: readFrom({ access_token: 'orphan-token' }),
  removeStorage: throwingRemover(resilientEnsureAttempts),
  setLoggedIn(value) {
    resilientEnsureLoginStates.push(value)
  },
  reLaunch(options) {
    resilientEnsureReLaunches.push(options)
  }
}))

assert.deepEqual(resilientClearAttempts, PATIENT_DATA_KEYS)
assert.equal(resilientClearCall.error, undefined)
assert.deepEqual(resilientClearCall.value, {
  ok: false,
  failedKeys: ['scale_draft_asrs']
})
assert.deepEqual(
  resilientEndAttempts,
  [...PATIENT_DATA_KEYS, ...SESSION_KEYS]
)
assert.equal(resilientEndCall.error, undefined)
assert.deepEqual(resilientEndCall.value, {
  ok: false,
  failedKeys: ['scale_draft_asrs', 'access_token'],
  failedPageCount: 0
})
assert.deepEqual(resilientEndLoginStates, [false])
assert.deepEqual(
  resilientEnsureAttempts,
  [...PATIENT_DATA_KEYS, ...SESSION_KEYS]
)
assert.equal(resilientEnsureCall.error, undefined)
assert.equal(resilientEnsureCall.value, false)
assert.deepEqual(resilientEnsureLoginStates, [false])
assert.equal(resilientEnsureReLaunches.length, 1)
assert.equal(resilientEnsureReLaunches[0].url, '/pages/login/index')
assert.equal(typeof resilientEnsureReLaunches[0].success, 'function')
assert.equal(typeof resilientEnsureReLaunches[0].fail, 'function')

let synchronousReLaunchFailures = 0
assert.equal(ensurePatientSession({
  readStorage: readFrom({}),
  removeStorage() {},
  setLoggedIn() {},
  reLaunch() {
    throw new Error('reLaunch crashed')
  },
  onReLaunchFail() {
    synchronousReLaunchFailures += 1
  }
}), false)
assert.equal(synchronousReLaunchFailures, 1)

const previousWx = global.wx
const previousGetApp = global.getApp
delete global.wx
delete global.getApp
try {
  assert.equal(hasValidPatientSession(), false)
  assert.deepEqual(summarizePatientData(), EMPTY_SUMMARY)
  assert.doesNotThrow(() => clearPatientData())
  assert.doesNotThrow(() => endPatientSession())
  let unavailableReLaunchFailures = 0
  assert.equal(ensurePatientSession({
    onReLaunchFail() {
      unavailableReLaunchFailures += 1
    }
  }), false)
  assert.equal(unavailableReLaunchFailures, 1)
} finally {
  if (previousWx === undefined) delete global.wx
  else global.wx = previousWx
  if (previousGetApp === undefined) delete global.getApp
  else global.getApp = previousGetApp
}

console.log('会话与本地数据隐私测试全部通过')
