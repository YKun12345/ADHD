const assert = require('node:assert/strict')

const { LATEST_RESULTS_KEY } = require('../utils/cognitive-results')

const calls = {
  navigateTo: [],
  navigateBack: []
}
let storage = {}
let pageDefinition

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  navigateTo(options) {
    calls.navigateTo.push(options)
  },
  navigateBack(options) {
    calls.navigateBack.push(options)
  }
}

global.Page = (definition) => {
  pageDefinition = definition
}

require('../pages/cognitive-center/index')

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

function payload(type, accuracy) {
  return {
    test_type: type,
    result_json: {
      raw_result: {
        accuracy
      },
      finished_at: `2026-08-21T0${accuracy}:00:00.000Z`
    }
  }
}

function reset() {
  calls.navigateTo = []
  calls.navigateBack = []
  storage = {
    access_token: 'test-token',
    current_user: {
      id: 1,
      role: 'patient',
      full_name: '认知中心患者'
    }
  }
}

reset()
const emptyPage = createPage()
emptyPage.onLoad()
emptyPage.onShow()
assert.equal(emptyPage.data.patientName, '认知中心患者')
assert.equal(emptyPage.data.completedCount, 0)
assert.equal(emptyPage.data.totalCount, 2)
assert.equal(emptyPage.data.progressPercent, 0)
assert.equal(emptyPage.data.cards.length, 2)

storage[LATEST_RESULTS_KEY] = {
  reaction: payload('reaction', 80)
}
emptyPage.onShow()
assert.equal(emptyPage.data.completedCount, 1)
assert.equal(emptyPage.data.progressPercent, 50)
assert.equal(emptyPage.data.cards[0].primaryMetric, '正确率 80%')

storage[LATEST_RESULTS_KEY].stroop = payload('stroop', 75)
emptyPage.onShow()
assert.equal(emptyPage.data.completedCount, 2)
assert.equal(emptyPage.data.allCompleted, true)
assert.equal(emptyPage.data.progressPercent, 100)

emptyPage.handleTestTap({
  currentTarget: {
    dataset: {
      id: 'reaction'
    }
  }
})
emptyPage.handleTestTap({
  currentTarget: {
    dataset: {
      id: 'stroop'
    }
  }
})
emptyPage.handleTestTap({
  currentTarget: {
    dataset: {
      id: 'unknown'
    }
  }
})
assert.deepEqual(calls.navigateTo, [
  { url: '/pages/cognitive/index' },
  { url: '/pages/stroop/index' }
])

emptyPage.goBack()
assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

console.log('认知测试中心控制逻辑测试全部通过')
