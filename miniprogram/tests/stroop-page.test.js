const assert = require('node:assert/strict')

const {
  COLORS,
  STROOP_TRIALS,
  evaluateStroopChoice,
  buildStroopPayload
} = require('../utils/stroop-test')
const { LATEST_RESULTS_KEY } = require('../utils/cognitive-results')
const { advancePatientDataRevision } = require('../utils/session-privacy')

const calls = {
  requests: [],
  storageWrites: [],
  storageRemovals: [],
  navigateBack: []
}

let storage = {}
let requestImplementation = async () => ({ id: 1 })
let pageDefinition
let now = 1000
let nextTimerId = 1
let timers = new Map()

const nativeSetTimeout = global.setTimeout
const nativeClearTimeout = global.clearTimeout
const nativeDateNow = Date.now

global.setTimeout = (callback, delay) => {
  const id = nextTimerId
  nextTimerId += 1
  timers.set(id, { callback, delay })
  return id
}
global.clearTimeout = (id) => timers.delete(id)
Date.now = () => now

function runTimer(id) {
  const timer = timers.get(id)
  assert.ok(timer, `定时器 ${id} 应存在`)
  timers.delete(id)
  timer.callback()
}

const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = {
  id: requestPath,
  filename: requestPath,
  loaded: true,
  exports: {
    request(options) {
      calls.requests.push(options)
      return requestImplementation(options)
    },
    isPatientSessionError(error) {
      return Boolean(error) && (
        error.code === 'SESSION_CHANGED' || error.statusCode === 401
      )
    }
  }
}

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  setStorageSync(key, value) {
    storage[key] = value
    calls.storageWrites.push([key, value])
  },
  removeStorageSync(key) {
    delete storage[key]
    calls.storageRemovals.push(key)
  },
  navigateBack(options) {
    calls.navigateBack.push(options)
  }
}

global.Page = (definition) => {
  pageDefinition = definition
}

require('../pages/stroop/index')

function createPage() {
  return {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(patch) {
      this.data = {
        ...this.data,
        ...patch
      }
    }
  }
}

function reset() {
  calls.requests = []
  calls.storageWrites = []
  calls.storageRemovals = []
  calls.navigateBack = []
  storage = {
    access_token: 'test-token',
    current_user: {
      id: 1,
      role: 'patient',
      full_name: 'Stroop 测试患者'
    }
  }
  requestImplementation = async () => ({ id: 1 })
  now = 1000
  nextTimerId = 1
  timers = new Map()
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

async function run() {
  reset()
  const page = createPage()
  page.onLoad()
  assert.equal(page.data.patientName, 'Stroop 测试患者')
  assert.equal(page.data.phase, 'intro')
  assert.deepEqual(page.data.colors, COLORS)
  assert.equal(page.data.totalTrials, 8)

  page.startTest()
  assert.equal(page.data.phase, 'testing')
  assert.equal(page.data.currentTrialNumber, 1)
  assert.equal(page.data.currentWord, '红')
  assert.equal(page.data.currentColorHex, '#c85c52')

  now = 1245
  page.handleAnswer({
    currentTarget: {
      dataset: {
        key: 'red'
      }
    }
  })
  assert.equal(page.data.phase, 'feedback')
  assert.equal(page.data.feedbackCorrect, true)
  assert.equal(page._records.length, 1)
  assert.equal(page._records[0].reactionTimeMs, 245)
  assert.equal(timers.get(page._feedbackTimer).delay, 350)

  page.handleAnswer({
    currentTarget: {
      dataset: {
        key: 'green'
      }
    }
  })
  assert.equal(page._records.length, 1, '反馈期间重复点击不能重复记录')

  runTimer(page._feedbackTimer)
  assert.equal(page.data.phase, 'testing')
  assert.equal(page.data.currentTrialNumber, 2)
  assert.equal(page.data.currentWord, '绿')
  assert.equal(page.data.currentColorHex, '#3976b8')

  reset()
  const completePage = createPage()
  completePage.startTest()
  completePage._records = STROOP_TRIALS.slice(0, 7).map(
    (trial, index) => evaluateStroopChoice(
      trial,
      trial.colorKey,
      300 + index
    )
  )
  completePage.setData({
    currentTrialIndex: 7,
    currentTrialNumber: 8,
    phase: 'testing'
  })
  completePage._showTrial()
  now += 400
  completePage.handleAnswer({
    currentTarget: {
      dataset: {
        key: STROOP_TRIALS[7].colorKey
      }
    }
  })
  runTimer(completePage._feedbackTimer)
  await flushPromises()
  assert.equal(completePage.data.phase, 'result')
  assert.equal(completePage.data.result.total_trials, 8)
  assert.equal(completePage.data.syncStatus, '已同步')
  assert.equal(calls.requests.length, 1)
  const expectedPayload = buildStroopPayload(
    completePage._records,
    completePage._finishedAt
  )
  assert.deepEqual(calls.requests[0], {
    url: '/patient/submit_cognitive_test',
    method: 'POST',
    data: expectedPayload
  })
  assert.deepEqual(storage[LATEST_RESULTS_KEY].stroop, expectedPayload)

  reset()
  requestImplementation = async () => {
    throw new Error('offline')
  }
  const offlinePage = createPage()
  offlinePage._records = STROOP_TRIALS.map((trial) => (
    evaluateStroopChoice(trial, trial.colorKey, 280)
  ))
  await offlinePage._completeTest()
  assert.equal(offlinePage.data.syncStatus, '待同步')
  assert.deepEqual(storage.pending_stroop_result, buildStroopPayload(
    offlinePage._records,
    offlinePage._finishedAt
  ))
  assert.equal(storage[LATEST_RESULTS_KEY].stroop.test_type, 'stroop')

  requestImplementation = async () => ({ id: 2 })
  await offlinePage.retrySync()
  assert.equal(offlinePage.data.syncStatus, '已同步')
  assert.equal(storage.pending_stroop_result, undefined)

  for (const sessionError of [
    Object.assign(new Error('expired'), { statusCode: 401 }),
    Object.assign(new Error('changed'), { code: 'SESSION_CHANGED' })
  ]) {
    reset()
    requestImplementation = async () => {
      throw sessionError
    }
    const invalidSessionPage = createPage()
    await invalidSessionPage._syncResult({ test_type: 'stroop' })
    assert.equal(storage.pending_stroop_result, undefined)
    assert.equal(
      calls.storageWrites.some(([key]) => key === 'pending_stroop_result'),
      false
    )
  }

  reset()
  const staleTimerPage = createPage()
  staleTimerPage.startTest()
  staleTimerPage._records = STROOP_TRIALS.slice(0, 7).map(
    (trial) => evaluateStroopChoice(trial, trial.colorKey, 260)
  )
  staleTimerPage.setData({
    currentTrialIndex: 7,
    currentTrialNumber: 8,
    phase: 'testing'
  })
  staleTimerPage._showTrial()
  staleTimerPage.handleAnswer({
    currentTarget: {
      dataset: { key: STROOP_TRIALS[7].colorKey }
    }
  })
  const staleCompletionTimer = staleTimerPage._feedbackTimer
  advancePatientDataRevision()
  runTimer(staleCompletionTimer)
  await flushPromises()
  assert.equal(storage[LATEST_RESULTS_KEY], undefined)

  reset()
  const endedPage = createPage()
  endedPage.startTest()
  endedPage.handleAnswer({
    currentTarget: { dataset: { key: 'red' } }
  })
  assert.equal(typeof endedPage.onPatientSessionEnded, 'function')
  endedPage.onPatientSessionEnded()
  assert.equal(timers.size, 0)
  assert.deepEqual(endedPage._records, [])
  assert.equal(endedPage.data.running, false)

  reset()
  const unloadPage = createPage()
  unloadPage.startTest()
  unloadPage.handleAnswer({
    currentTarget: {
      dataset: {
        key: 'red'
      }
    }
  })
  const activeTimer = unloadPage._feedbackTimer
  unloadPage.onUnload()
  assert.equal(timers.has(activeTimer), false)
  assert.equal(unloadPage.data.running, false)

  const navigationPage = createPage()
  navigationPage.goBack()
  assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

  console.log('Stroop 页面控制逻辑测试全部通过')
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    global.setTimeout = nativeSetTimeout
    global.clearTimeout = nativeClearTimeout
    Date.now = nativeDateNow
  })
