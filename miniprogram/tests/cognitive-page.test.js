const assert = require('node:assert/strict')

const {
  TRIAL_SEQUENCE,
  evaluateTrial,
  buildCognitivePayload
} = require('../utils/gonogo-test')

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

global.clearTimeout = (id) => {
  timers.delete(id)
}

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

require('../pages/cognitive/index')

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
    current_user: {
      full_name: '认知测试患者'
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
  assert.equal(page.data.patientName, '认知测试患者')
  assert.equal(page.data.phase, 'intro')
  assert.equal(page.data.totalTrials, 10)

  page.startTest()
  assert.equal(page.data.phase, 'waiting')
  assert.equal(page.data.running, true)
  assert.equal(page.data.currentTrialNumber, 1)
  assert.equal(timers.size, 1)
  const waitingTimer = page._stimulusTimer
  assert.ok([800, 1000, 1200, 1400].includes(timers.get(waitingTimer).delay))

  page.startTest()
  assert.equal(timers.size, 1, '重复启动不能创建额外定时器')

  page.handleTestTap()
  assert.equal(page.data.phase, 'feedback')
  assert.equal(page._records.length, 1)
  assert.equal(page._records[0].errorType, 'false_start')
  assert.equal(timers.has(waitingTimer), false)
  assert.equal(timers.get(page._feedbackTimer).delay, 450)

  runTimer(page._feedbackTimer)
  assert.equal(page.data.currentTrialNumber, 2)
  assert.equal(page.data.phase, 'waiting')

  const secondWaitingTimer = page._stimulusTimer
  runTimer(secondWaitingTimer)
  assert.equal(page.data.phase, 'stimulus')
  assert.equal(page.data.stimulusType, TRIAL_SEQUENCE[1])
  assert.equal(timers.get(page._responseTimer).delay, 800)

  now = 1326
  page.handleTestTap()
  assert.equal(page._records[1].correct, true)
  assert.equal(page._records[1].reactionTimeMs, 326)
  assert.equal(page.data.phase, 'feedback')

  reset()
  const timeoutPage = createPage()
  timeoutPage.startTest()
  timeoutPage._records = TRIAL_SEQUENCE.slice(0, 9).map((type) => (
    evaluateTrial({
      type,
      action: type === 'go' ? 'tap' : 'timeout',
      reactionTimeMs: 300
    })
  ))
  timeoutPage.setData({
    currentTrialIndex: 9,
    currentTrialNumber: 10,
    phase: 'waiting'
  })
  timeoutPage._clearTimers()
  timeoutPage._showStimulus()
  assert.equal(timeoutPage.data.stimulusType, 'nogo')
  runTimer(timeoutPage._responseTimer)
  assert.equal(timeoutPage._records[9].correct, true)
  runTimer(timeoutPage._feedbackTimer)
  await flushPromises()
  assert.equal(timeoutPage.data.phase, 'result')
  assert.equal(timeoutPage.data.result.total_trials, 10)
  assert.equal(timeoutPage.data.result.correct_trials, 10)
  assert.equal(timeoutPage.data.syncStatus, '已同步')
  assert.equal(calls.requests.length, 1)
  assert.deepEqual(calls.requests[0], {
    url: '/patient/submit_cognitive_test',
    method: 'POST',
    data: buildCognitivePayload(
      timeoutPage._records,
      timeoutPage._finishedAt
    )
  })

  reset()
  requestImplementation = async () => {
    throw new Error('offline')
  }
  const offlinePage = createPage()
  offlinePage._records = TRIAL_SEQUENCE.map((type) => (
    evaluateTrial({
      type,
      action: type === 'go' ? 'tap' : 'timeout',
      reactionTimeMs: 280
    })
  ))
  await offlinePage._completeTest()
  assert.equal(offlinePage.data.phase, 'result')
  assert.equal(offlinePage.data.syncStatus, '待同步')
  assert.deepEqual(
    storage.pending_cognitive_result,
    buildCognitivePayload(offlinePage._records, offlinePage._finishedAt)
  )

  requestImplementation = async () => ({ id: 2 })
  await offlinePage.retrySync()
  assert.equal(offlinePage.data.syncStatus, '已同步')
  assert.equal(storage.pending_cognitive_result, undefined)

  reset()
  let releaseRequest
  requestImplementation = () => new Promise((resolve) => {
    releaseRequest = resolve
  })
  const guardedPage = createPage()
  guardedPage._records = TRIAL_SEQUENCE.map((type) => (
    evaluateTrial({
      type,
      action: type === 'go' ? 'tap' : 'timeout',
      reactionTimeMs: 250
    })
  ))
  guardedPage._finishedAt = '2026-08-21T02:30:00.000Z'
  guardedPage.setData({ result: { total_trials: 10 } })
  const firstSync = guardedPage.retrySync()
  const secondSync = guardedPage.retrySync()
  assert.equal(calls.requests.length, 1)
  releaseRequest({ id: 3 })
  await Promise.all([firstSync, secondSync])

  reset()
  const unloadPage = createPage()
  unloadPage.startTest()
  const activeTimer = unloadPage._stimulusTimer
  unloadPage.onUnload()
  assert.equal(timers.has(activeTimer), false)
  assert.equal(unloadPage.data.running, false)

  const navigationPage = createPage()
  navigationPage.goBack()
  assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

  console.log('Go/No-Go 页面控制逻辑测试全部通过')
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
