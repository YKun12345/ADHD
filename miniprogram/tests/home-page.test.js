const assert = require('node:assert/strict')

const calls = {
  request: [],
  storageWrites: [],
  toasts: [],
  navigateTo: []
}

let requestImplementation = async () => ({})
let storage = {}
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
  showToast(options) {
    calls.toasts.push(options)
  },
  navigateTo(options) {
    calls.navigateTo.push(options)
  }
}

global.Page = (definition) => {
  pageDefinition = definition
}

require('../pages/home/index')

function createPage() {
  const page = {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(patch) {
      this.data = {
        ...this.data,
        ...patch
      }
    }
  }

  return page
}

function reset(overrides = {}) {
  calls.request = []
  calls.storageWrites = []
  calls.toasts = []
  calls.navigateTo = []
  storage = {
    current_user: {
      full_name: '首页测试患者'
    },
    ...overrides
  }
}

async function run() {
  reset({
    patient_dashboard_cache: {
      currentDay: 3,
      completedDays: [1, 2]
    }
  })

  requestImplementation = async (options) => {
    calls.request.push(options)
    return {
      current_day: 5,
      completed_days: [1, 2, 3, 4],
      total_days: 14,
      logs: []
    }
  }

  const successPage = createPage()
  successPage.onLoad()
  assert.equal(successPage.data.userName, '首页测试患者')

  await successPage.onShow()
  assert.deepEqual(calls.request, [
    {
      url: '/patient/dashboard_status',
      method: 'GET'
    }
  ])
  assert.equal(successPage.data.currentDay, 5)
  assert.equal(successPage.data.completedCount, 4)
  assert.equal(successPage.data.progressPercent, 29)
  assert.equal(successPage.data.sourceLabel, '已同步')
  assert.equal(successPage.data.statusMessage, '')
  assert.deepEqual(calls.storageWrites, [
    [
      'patient_dashboard_cache',
      {
        currentDay: 5,
        completedDays: [1, 2, 3, 4]
      }
    ]
  ])

  reset({
    patient_dashboard_cache: {
      currentDay: 4,
      completedDays: [1, 2, 3]
    }
  })

  requestImplementation = async (options) => {
    calls.request.push(options)
    throw new Error('offline')
  }

  const offlinePage = createPage()
  offlinePage.onLoad()
  await offlinePage.onShow()
  assert.equal(offlinePage.data.userName, '首页测试患者')
  assert.equal(offlinePage.data.currentDay, 4)
  assert.equal(offlinePage.data.completedCount, 3)
  assert.equal(offlinePage.data.progressPercent, 21)
  assert.equal(offlinePage.data.sourceLabel, '本地计划')
  assert.equal(
    offlinePage.data.statusMessage,
    '暂时无法同步，当前展示本地计划'
  )
  assert.equal(offlinePage.data.loadingDashboard, false)
  assert.equal(calls.navigateTo.length, 0)

  offlinePage.handleEntryTap({
    currentTarget: {
      dataset: {
        id: 'scale'
      }
    }
  })
  assert.equal(calls.navigateTo.length, 0)
  assert.deepEqual(calls.toasts.at(-1), {
    title: '该功能正在按计划开发',
    icon: 'none'
  })

  offlinePage.handleTaskTap({
    currentTarget: {
      dataset: {
        id: 'unknown'
      }
    }
  })
  assert.equal(calls.navigateTo.length, 0)

  reset()
  storage.current_user.patient_profile = {
    patient_type: 'adult'
  }
  const adultNavigationPage = createPage()
  adultNavigationPage.onLoad()
  adultNavigationPage.handleEntryTap({
    currentTarget: {
      dataset: {
        id: 'scale'
      }
    }
  })
  assert.deepEqual(calls.navigateTo, [
    {
      url: '/pages/scale/index'
    }
  ])

  adultNavigationPage.handleTaskTap({
    currentTarget: {
      dataset: {
        id: 'cognitive'
      }
    }
  })
  assert.deepEqual(calls.navigateTo.at(-1), {
    url: '/pages/cognitive-center/index'
  })
  adultNavigationPage.handleEntryTap({ currentTarget: { dataset: { id: 'tracking' } } })
  assert.deepEqual(calls.navigateTo.at(-1), { url: '/pages/tracking/index' })

  reset()
  storage.current_user.patient_profile = {
    patient_type: 'child'
  }
  const childNavigationPage = createPage()
  childNavigationPage.onLoad()
  childNavigationPage.handleTaskTap({
    currentTarget: {
      dataset: {
        id: 'scale'
      }
    }
  })
  assert.deepEqual(calls.navigateTo, [
    {
      url: '/pages/scale/index'
    }
  ])

  childNavigationPage.handleEntryTap({
    currentTarget: {
      dataset: {
        id: 'cognitive'
      }
    }
  })
  assert.deepEqual(calls.navigateTo.at(-1), {
    url: '/pages/cognitive-center/index'
  })
  childNavigationPage.handleTaskTap({ currentTarget: { dataset: { id: 'tracking' } } })
  assert.deepEqual(calls.navigateTo.at(-1), { url: '/pages/tracking/index' })

  childNavigationPage.openServerSettings()
  assert.deepEqual(calls.navigateTo.at(-1), {
    url: '/pages/server-settings/index'
  })

  console.log('患者首页控制逻辑测试全部通过')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
