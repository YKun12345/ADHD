const assert = require('node:assert/strict')

const {
  ASRS_DRAFT_KEY,
  ASRS_CONFIG,
  getQuestionState
} = require('../utils/asrs-scale')

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
    current_user: {
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
  total_score: 20,
  risk_level: 'low',
  summary: '当前结果用于测试。',
  recommendations: ['继续完成后续任务。']
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
  const childPage = createPage()
  childPage.onLoad()
  assert.equal(childPage.data.patientSupported, false)
  assert.equal(
    childPage.data.unsupportedMessage,
    '儿童患者请使用 SNAP-IV 儿童量表，该量表将在 D5 开放。'
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
  assert.equal(successPage.data.submitting, false)

  reset('adult', Array(18).fill(3))
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
  assert.deepEqual(calls.toasts.at(-1), {
    title: '量表提交失败，答案已保留',
    icon: 'none',
    duration: 2500
  })

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
