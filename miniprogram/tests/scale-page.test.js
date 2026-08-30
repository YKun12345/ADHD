const assert = require('node:assert/strict')

const {
  ASRS_DRAFT_KEY,
  ASRS_CONFIG,
  getQuestionState
} = require('../utils/asrs-scale')
const {
  SNAP_DRAFT_KEY,
  SNAP_CONFIG
} = require('../utils/snap-scale')
const {
  SCALE_LATEST_RESULT_KEY
} = require('../utils/report-data')

const calls = {
  request: [],
  storageWrites: [],
  storageRemovals: [],
  toasts: [],
  navigateBack: []
}

let storage = {}
let requestImplementation = async () => ({})
let pageDefinition

const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = {
  id: requestPath,
  filename: requestPath,
  loaded: true,
  exports: {
    request(options) {
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
  showToast(options) {
    calls.toasts.push(options)
  },
  navigateBack(options) {
    calls.navigateBack.push(options)
  }
}

global.Page = (definition) => {
  pageDefinition = definition
}

require('../pages/scale/index')

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

function reset(patientType = 'adult', draft) {
  calls.request = []
  calls.storageWrites = []
  calls.storageRemovals = []
  calls.toasts = []
  calls.navigateBack = []
  storage = {
    access_token: 'test-token',
    current_user: {
      id: 1,
      role: 'patient',
      full_name: '量表测试患者',
      patient_profile: {
        patient_type: patientType
      }
    }
  }

  if (draft !== undefined) {
    storage[ASRS_DRAFT_KEY] = draft
  }
}

const completeResult = {
  id: 1,
  scale_type: 'ASRS',
  respondent_type: 'self',
  total_score: 20,
  risk_level: 'low',
  radar_scores: {
    attention_control: 12,
    organization: 11,
    task_activation: 10,
    hyperactivity: 9,
    impulsivity: 8
  },
  sub_scores: {},
  summary: '当前结果用于测试。',
  recommendations: ['继续完成后续任务。'],
  created_at: '2026-08-21T08:00:00.000Z'
}

async function run() {
  reset('adult')
  const adultPage = createPage()
  adultPage.onLoad()
  assert.equal(adultPage.data.patientSupported, true)
  assert.equal(adultPage.data.patientName, '量表测试患者')
  assert.equal(adultPage.data.currentIndex, 0)
  assert.equal(adultPage.data.currentQuestion, ASRS_CONFIG.questions[0])
  assert.equal(adultPage.data.selectedValue, null)

  adultPage.selectOption({
    currentTarget: {
      dataset: {
        value: 2
      }
    }
  })
  assert.deepEqual(adultPage.data.answers, [2])
  assert.equal(adultPage.data.selectedValue, 2)
  assert.deepEqual(calls.storageWrites.at(-1), [
    ASRS_DRAFT_KEY,
    [2]
  ])

  const storageWritesBeforeLockedSelection = calls.storageWrites.length
  adultPage.setData({ submitting: true })
  adultPage.selectOption({
    currentTarget: {
      dataset: {
        value: 4
      }
    }
  })
  assert.deepEqual(adultPage.data.answers, [2], '提交中不得改变量表答案快照')
  assert.equal(calls.storageWrites.length, storageWritesBeforeLockedSelection, '提交中不得写入量表草稿')
  adultPage.setData({ submitting: false })

  adultPage.goNext()
  assert.equal(adultPage.data.currentIndex, 1)
  assert.equal(adultPage.data.selectedValue, null)

  adultPage.goPrevious()
  assert.equal(adultPage.data.currentIndex, 0)
  assert.equal(adultPage.data.selectedValue, 2)

  reset('adult')
  const unansweredPage = createPage()
  unansweredPage.onLoad()
  unansweredPage.goNext()
  assert.equal(unansweredPage.data.currentIndex, 0)
  assert.deepEqual(calls.toasts.at(-1), {
    title: '请先选择本题答案',
    icon: 'none'
  })

  reset('adult', [0, 1, 2])
  const draftPage = createPage()
  draftPage.onLoad()
  assert.deepEqual(draftPage.data.answers, [0, 1, 2])
  assert.equal(draftPage.data.currentIndex, 3)
  assert.equal(draftPage.data.selectedValue, null)

  reset('child')
  storage[SNAP_DRAFT_KEY] = [0, 1]
  const childPage = createPage()
  childPage.onLoad()
  assert.equal(childPage.data.patientSupported, true)
  assert.equal(childPage.data.title, SNAP_CONFIG.title)
  assert.equal(childPage.data.options.length, 4)
  assert.equal(childPage.data.totalQuestions, 26)
  assert.equal(childPage.data.currentIndex, 2)
  assert.deepEqual(childPage.data.answers, [0, 1])

  reset('child')
  const incompleteChildPage = createPage()
  incompleteChildPage.onLoad()
  await incompleteChildPage.submitScale()
  assert.deepEqual(calls.toasts.at(-1), {
    title: '请完成全部26道题目',
    icon: 'none'
  })
  assert.equal(incompleteChildPage.data.currentIndex, 0)

  reset('adult')
  const incompleteAdultPage = createPage()
  incompleteAdultPage.onLoad()
  await incompleteAdultPage.submitScale()
  assert.equal(calls.toasts.at(-1).title, '请完成全部18道题目')

  reset('unknown')
  const unknownPage = createPage()
  unknownPage.onLoad()
  assert.equal(unknownPage.data.patientSupported, false)
  assert.equal(
    unknownPage.data.unsupportedMessage,
    '暂时无法识别患者量表类型，请返回首页后重试。'
  )

  reset('adult', Array(18).fill(2))
  requestImplementation = async (options) => {
    calls.request.push(options)
    return completeResult
  }
  const successPage = createPage()
  successPage.onLoad()
  await successPage.submitScale()
  assert.equal(calls.request.length, 1)
  assert.deepEqual(calls.request[0], {
    url: '/patient/submit_scale',
    method: 'POST',
    data: {
      scale_type: 'ASRS',
      respondent_type: 'self',
      answers: Array(18).fill(2)
    }
  })
  assert.deepEqual(calls.storageRemovals, [ASRS_DRAFT_KEY])
  assert.equal(successPage.data.showResult, true)
  assert.deepEqual(successPage.data.result, completeResult)
  assert.equal(successPage.data.resultRiskLabel, '低风险')
  assert.equal(successPage.data.submitting, false)
  assert.deepEqual(storage[SCALE_LATEST_RESULT_KEY], completeResult)
  assert.deepEqual(calls.storageWrites.at(-1), [
    SCALE_LATEST_RESULT_KEY,
    completeResult
  ])

  reset('child')
  storage[SNAP_DRAFT_KEY] = Array(26).fill(1)
  requestImplementation = async (options) => {
    calls.request.push(options)
    return {
      ...completeResult,
      scale_type: 'SNAP_IV',
      respondent_type: 'parent',
      radar_scores: {
        attention_control: 12,
        organization: 11,
        hyperactivity: 10,
        impulsivity: 9,
        emotional_regulation: 8
      },
      risk_level: 'medium'
    }
  }
  const childSubmitPage = createPage()
  childSubmitPage.onLoad()
  await childSubmitPage.submitScale()
  assert.deepEqual(calls.request.at(-1), {
    url: '/patient/submit_scale',
    method: 'POST',
    data: {
      scale_type: 'SNAP_IV',
      respondent_type: 'parent',
      answers: Array(26).fill(1)
    }
  })
  assert.deepEqual(calls.storageRemovals, [SNAP_DRAFT_KEY])
  assert.equal(childSubmitPage.data.resultRiskLabel, '中等风险')
  assert.equal(storage[SCALE_LATEST_RESULT_KEY].scale_type, 'SNAP_IV')

  reset('adult', Array(18).fill(3))
  storage[SCALE_LATEST_RESULT_KEY] = completeResult
  requestImplementation = async (options) => {
    calls.request.push(options)
    throw new Error('offline')
  }
  const failedPage = createPage()
  failedPage.onLoad()
  await failedPage.submitScale()
  assert.equal(failedPage.data.showResult, false)
  assert.equal(failedPage.data.submitting, false)
  assert.deepEqual(storage[ASRS_DRAFT_KEY], Array(18).fill(3))
  assert.deepEqual(storage[SCALE_LATEST_RESULT_KEY], completeResult)
  assert.deepEqual(calls.toasts.at(-1), {
    title: '量表提交失败，答案已保留',
    icon: 'none',
    duration: 2500
  })

  reset('adult', Array(18).fill(2))
  storage[SCALE_LATEST_RESULT_KEY] = completeResult
  requestImplementation = async () => ({
    ...completeResult,
    radar_scores: {
      attention_control: 12
    }
  })
  const incompleteCachePage = createPage()
  incompleteCachePage.onLoad()
  await incompleteCachePage.submitScale()
  assert.deepEqual(storage[SCALE_LATEST_RESULT_KEY], completeResult)

  reset('adult', Array(18).fill(1))
  let releaseRequest
  requestImplementation = (options) => {
    calls.request.push(options)
    return new Promise((resolve) => {
      releaseRequest = () => resolve(completeResult)
    })
  }
  const guardedPage = createPage()
  guardedPage.onLoad()
  const firstSubmit = guardedPage.submitScale()
  const secondSubmit = guardedPage.submitScale()
  assert.equal(calls.request.length, 1)
  releaseRequest()
  await Promise.all([firstSubmit, secondSubmit])

  reset('adult')
  const navigationPage = createPage()
  navigationPage.goBack()
  assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

  const lastState = getQuestionState(17, Array(18).fill(4))
  assert.equal(lastState.isLastQuestion, true)

  console.log('ASRS 页面控制逻辑测试全部通过')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
