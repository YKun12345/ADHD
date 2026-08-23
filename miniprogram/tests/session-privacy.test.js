const assert = require('node:assert/strict')

const {
  SESSION_KEYS,
  PATIENT_DATA_KEYS,
  hasValidPatientSession,
  summarizePatientData,
  clearPatientData,
  endPatientSession,
  ensurePatientSession
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
  'tracking_local_logs',
  'tracking_pending_logs'
])
assert.equal(PATIENT_DATA_KEYS.includes('api_base_url'), false)

assert.equal(hasValidPatientSession(readFrom({
  access_token: '  patient-token  ',
  current_user: {}
})), true)

for (const invalidStorage of [
  {},
  { access_token: '', current_user: {} },
  { access_token: '   ', current_user: {} },
  { access_token: 123, current_user: {} },
  { access_token: 'token' },
  { access_token: 'token', current_user: null },
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
  resultCount: 2,
  trackingDayCount: 0,
  pendingCount: 2,
  totalLocalItems: 4
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
clearPatientData((key) => clearedKeys.push(key))
assert.deepEqual(clearedKeys, PATIENT_DATA_KEYS)
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
endPatientSession({
  removeStorage(key) {
    fullRemovedKeys.push(key)
    delete fullStorage[key]
  },
  setLoggedIn(value) {
    fullLoginStates.push(value)
  }
})
assert.deepEqual(fullRemovedKeys, [...PATIENT_DATA_KEYS, ...SESSION_KEYS])
assert.deepEqual(fullLoginStates, [false])
assert.deepEqual(fullStorage, {
  api_base_url: 'http://192.168.1.8:8000/api/v1'
})

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
    current_user: { id: 9 }
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
assert.deepEqual(invalidEnsureCalls, {
  removed: [...PATIENT_DATA_KEYS, ...SESSION_KEYS],
  loginStates: [false],
  reLaunches: [{ url: '/pages/login/index' }]
})
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
assert.deepEqual(invalidOptOutCalls.reLaunches, [
  { url: '/pages/login/index' }
])
assert.deepEqual(invalidOptOutStorage, {
  api_base_url: 'https://api.example.com/api/v1'
})

const resilientClearAttempts = []
const resilientClearCall = captureCall(() => {
  clearPatientData(throwingRemover(resilientClearAttempts))
})

const resilientEndAttempts = []
const resilientEndLoginStates = []
const resilientEndCall = captureCall(() => {
  endPatientSession({
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
assert.deepEqual(
  resilientEndAttempts,
  [...PATIENT_DATA_KEYS, ...SESSION_KEYS]
)
assert.equal(resilientEndCall.error, undefined)
assert.deepEqual(resilientEndLoginStates, [false])
assert.deepEqual(
  resilientEnsureAttempts,
  [...PATIENT_DATA_KEYS, ...SESSION_KEYS]
)
assert.equal(resilientEnsureCall.error, undefined)
assert.equal(resilientEnsureCall.value, false)
assert.deepEqual(resilientEnsureLoginStates, [false])
assert.deepEqual(resilientEnsureReLaunches, [
  { url: '/pages/login/index' }
])

const previousWx = global.wx
const previousGetApp = global.getApp
delete global.wx
delete global.getApp
try {
  assert.equal(hasValidPatientSession(), false)
  assert.deepEqual(summarizePatientData(), EMPTY_SUMMARY)
  assert.doesNotThrow(() => clearPatientData())
  assert.doesNotThrow(() => endPatientSession())
  assert.equal(ensurePatientSession(), false)
} finally {
  if (previousWx === undefined) delete global.wx
  else global.wx = previousWx
  if (previousGetApp === undefined) delete global.getApp
  else global.getApp = previousGetApp
}

console.log('会话与本地数据隐私测试全部通过')
