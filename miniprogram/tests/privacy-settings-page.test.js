const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  PATIENT_DATA_KEYS,
  SESSION_KEYS,
  advancePatientDataRevision
} = require('../utils/session-privacy')

const pagePath = path.join(
  __dirname,
  '..',
  'pages',
  'privacy-settings',
  'index.js'
)

assert.equal(
  fs.existsSync(pagePath),
  true,
  '账号与隐私页控制器尚未创建'
)

const calls = {
  removals: [],
  modals: [],
  toasts: [],
  reLaunches: [],
  navigateBack: [],
  navigateTo: []
}

let storage = {}
let showModalImplementation
let reLaunchImplementation
let failedRemovalKey
let currentPages = []
let pageDefinition
const app = {
  globalData: {
    isLoggedIn: true,
    userInfo: { id: 7 }
  }
}

global.getApp = () => app
global.getCurrentPages = () => currentPages

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  removeStorageSync(key) {
    calls.removals.push(key)
    if (key === failedRemovalKey) {
      throw new Error(`cannot remove ${key}`)
    }
    delete storage[key]
  },
  showModal(options) {
    calls.modals.push(options)
    return showModalImplementation(options)
  },
  showToast(options) {
    calls.toasts.push(options)
  },
  reLaunch(options) {
    calls.reLaunches.push(options)
    return reLaunchImplementation(options)
  },
  navigateBack(options) {
    calls.navigateBack.push(options)
  },
  navigateTo(options) {
    calls.navigateTo.push(options)
  }
}

global.Page = (definition) => {
  pageDefinition = definition
}

delete require.cache[require.resolve(pagePath)]
require(pagePath)

function patientFixture(overrides = {}) {
  return {
    api_base_url: 'https://api.example.com/api/v1',
    access_token: 'patient-token',
    current_user: {
      id: 7,
      role: 'patient',
      full_name: '  李小明  '
    },
    patient_dashboard_cache: { currentDay: 3 },
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
    },
    ...overrides
  }
}

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

function reset(overrides = {}) {
  calls.removals = []
  calls.modals = []
  calls.toasts = []
  calls.reLaunches = []
  calls.navigateBack = []
  calls.navigateTo = []
  storage = patientFixture(overrides)
  failedRemovalKey = ''
  currentPages = []
  showModalImplementation = (options) => {
    options.success({ confirm: false, cancel: true })
  }
  reLaunchImplementation = (options) => {
    if (typeof options.success === 'function') options.success()
  }
  app.globalData.isLoggedIn = true
  app.globalData.userInfo = { id: 7 }
}

async function run() {
  reset()
  const summaryPage = createPage()
  summaryPage.onLoad()
  assert.equal(summaryPage.data.patientName, '李小明')
  assert.deepEqual(
    {
      draftCount: summaryPage.data.draftCount,
      resultCount: summaryPage.data.resultCount,
      trackingDayCount: summaryPage.data.trackingDayCount,
      pendingCount: summaryPage.data.pendingCount,
      totalLocalItems: summaryPage.data.totalLocalItems
    },
    {
      draftCount: 2,
      resultCount: 3,
      trackingDayCount: 2,
      pendingCount: 4,
      totalLocalItems: 11
    }
  )
  assert.deepEqual(
    Object.keys(summaryPage.data).sort(),
    [
      'acting',
      'draftCount',
      'patientName',
      'pendingCount',
      'resultCount',
      'totalLocalItems',
      'trackingDayCount'
    ]
  )

  reset({
    current_user: { id: 7, role: 'patient', full_name: '   ' }
  })
  const fallbackNamePage = createPage()
  fallbackNamePage.onLoad()
  assert.equal(fallbackNamePage.data.patientName, '患者')

  reset()
  const cancelledClearPage = createPage()
  cancelledClearPage.onLoad()
  const cancelledClearResult = await cancelledClearPage.clearLocalData()
  assert.equal(cancelledClearResult, false)
  assert.equal(cancelledClearPage.data.acting, false)
  assert.deepEqual(calls.removals, [])
  assert.equal(calls.modals.length, 1)
  assert.match(
    calls.modals[0].content,
    /只清除本机草稿、结果、追踪和待同步记录，不删除服务器已保存数据/
  )
  assert.equal(calls.modals[0].confirmText, '确认清除')

  reset()
  showModalImplementation = (options) => {
    options.fail(new Error('modal unavailable'))
  }
  const failedModalPage = createPage()
  failedModalPage.onLoad()
  assert.equal(await failedModalPage.clearLocalData(), false)
  assert.deepEqual(calls.removals, [])
  assert.equal(failedModalPage.data.acting, false)

  reset()
  showModalImplementation = () => {
    throw new Error('showModal crashed')
  }
  const throwingModalPage = createPage()
  throwingModalPage.onLoad()
  assert.equal(await throwingModalPage.clearLocalData(), false)
  assert.deepEqual(calls.removals, [])
  assert.equal(throwingModalPage.data.acting, false)

  reset()
  let pendingModal
  showModalImplementation = (options) => {
    pendingModal = options
  }
  const lockedPage = createPage()
  lockedPage.onLoad()
  const pendingClear = lockedPage.clearLocalData()
  assert.equal(lockedPage.data.acting, true)
  const repeatedClear = lockedPage.clearLocalData()
  const crossedLogout = lockedPage.logout()
  assert.equal(calls.modals.length, 1)
  assert.equal(await repeatedClear, false)
  assert.equal(await crossedLogout, false)
  pendingModal.success({ confirm: false, cancel: true })
  assert.equal(await pendingClear, false)
  assert.equal(lockedPage.data.acting, false)

  reset()
  let staleModal
  showModalImplementation = (options) => {
    staleModal = options
  }
  const staleModalPage = createPage()
  staleModalPage.onLoad()
  const staleClear = staleModalPage.clearLocalData()
  advancePatientDataRevision()
  staleModal.success({ confirm: true })
  assert.equal(await staleClear, false)
  assert.deepEqual(calls.removals, [])
  assert.equal(staleModalPage.data.acting, false)

  reset()
  showModalImplementation = (options) => {
    options.success({ confirm: true, cancel: false })
    options.fail(new Error('late duplicate callback'))
  }
  const confirmedClearPage = createPage()
  confirmedClearPage.onLoad()
  assert.equal(await confirmedClearPage.clearLocalData(), true)
  assert.deepEqual(calls.removals, PATIENT_DATA_KEYS)
  assert.equal(storage.access_token, 'patient-token')
  assert.deepEqual(storage.current_user, {
    id: 7,
    role: 'patient',
    full_name: '  李小明  '
  })
  assert.equal(storage.api_base_url, 'https://api.example.com/api/v1')
  for (const key of PATIENT_DATA_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(storage, key), false)
  }
  assert.deepEqual(
    {
      draftCount: confirmedClearPage.data.draftCount,
      resultCount: confirmedClearPage.data.resultCount,
      trackingDayCount: confirmedClearPage.data.trackingDayCount,
      pendingCount: confirmedClearPage.data.pendingCount,
      totalLocalItems: confirmedClearPage.data.totalLocalItems
    },
    {
      draftCount: 0,
      resultCount: 0,
      trackingDayCount: 0,
      pendingCount: 0,
      totalLocalItems: 0
    }
  )
  assert.deepEqual(calls.toasts, [
    {
      title: '本地数据已清除',
      icon: 'none'
    }
  ])
  assert.equal(confirmedClearPage.data.acting, false)

  reset()
  failedRemovalKey = 'scale_latest_result'
  showModalImplementation = (options) => {
    options.success({ confirm: true })
  }
  const failedClearPage = createPage()
  failedClearPage.onLoad()
  assert.equal(await failedClearPage.clearLocalData(), false)
  assert.deepEqual(calls.removals, PATIENT_DATA_KEYS)
  assert.equal(failedClearPage.data.acting, false)
  assert.equal(
    Object.prototype.hasOwnProperty.call(storage, 'scale_latest_result'),
    true
  )
  assert.match(calls.toasts[calls.toasts.length - 1].title, /清理失败/)
  assert.equal(
    calls.toasts.some((toast) => toast.icon === 'success'),
    false
  )

  reset()
  const cancelledLogoutPage = createPage()
  cancelledLogoutPage.onLoad()
  assert.equal(await cancelledLogoutPage.logout(), false)
  assert.deepEqual(calls.removals, [])
  assert.equal(cancelledLogoutPage.data.acting, false)
  assert.equal(calls.modals[0].confirmText, '退出账号')
  assert.match(calls.modals[0].content, /未同步数据将无法恢复/)

  reset()
  showModalImplementation = (options) => {
    options.success({ confirm: true })
  }
  const confirmedLogoutPage = createPage()
  confirmedLogoutPage.onLoad()
  assert.equal(await confirmedLogoutPage.logout(), true)
  assert.deepEqual(calls.removals, [
    ...PATIENT_DATA_KEYS,
    ...SESSION_KEYS
  ])
  assert.equal(Object.prototype.hasOwnProperty.call(storage, 'access_token'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(storage, 'current_user'), false)
  assert.equal(storage.api_base_url, 'https://api.example.com/api/v1')
  assert.equal(app.globalData.isLoggedIn, false)
  assert.equal(app.globalData.userInfo, null)
  assert.equal(calls.reLaunches.length, 1)
  assert.equal(calls.reLaunches[0].url, '/pages/login/index')
  assert.equal(typeof calls.reLaunches[0].success, 'function')
  assert.equal(typeof calls.reLaunches[0].fail, 'function')
  assert.equal(calls.navigateTo.length, 0)
  assert.equal(confirmedLogoutPage.data.acting, true)

  reset()
  failedRemovalKey = 'current_user'
  showModalImplementation = (options) => {
    options.success({ confirm: true })
  }
  const failedCleanupLogoutPage = createPage()
  failedCleanupLogoutPage.onLoad()
  assert.equal(await failedCleanupLogoutPage.logout(), false)
  assert.deepEqual(calls.removals, [
    ...PATIENT_DATA_KEYS,
    ...SESSION_KEYS
  ])
  assert.equal(calls.reLaunches.length, 0)
  assert.equal(failedCleanupLogoutPage.data.acting, false)
  assert.match(calls.toasts[calls.toasts.length - 1].title, /清理失败/)

  reset()
  showModalImplementation = (options) => {
    options.success({ confirm: true })
  }
  const failedPageScrubLogout = createPage()
  currentPages = [failedPageScrubLogout, {
    data: { patientName: 'stale patient' },
    setData() {
      throw new Error('setData failed')
    }
  }]
  failedPageScrubLogout.onLoad()
  assert.equal(await failedPageScrubLogout.logout(), false)
  assert.equal(calls.reLaunches.length, 0)
  assert.equal(failedPageScrubLogout.data.acting, false)
  assert.match(calls.toasts[calls.toasts.length - 1].title, /清理失败/)

  reset()
  showModalImplementation = (options) => {
    options.success({ confirm: true })
  }
  let failReLaunch
  reLaunchImplementation = (options) => {
    failReLaunch = options.fail
  }
  const failedReLaunchPage = createPage()
  currentPages = [failedReLaunchPage]
  failedReLaunchPage.onLoad()
  const failedReLaunchResult = failedReLaunchPage.logout()
  await Promise.resolve()
  assert.equal(failedReLaunchPage.data.acting, true)
  failReLaunch(new Error('reLaunch failed'))
  assert.equal(await failedReLaunchResult, false)
  assert.equal(failedReLaunchPage.data.acting, false)

  reset()
  showModalImplementation = (options) => {
    options.success({ confirm: true })
  }
  reLaunchImplementation = () => {
    throw new Error('reLaunch crashed')
  }
  const throwingReLaunchPage = createPage()
  throwingReLaunchPage.onLoad()
  assert.equal(await throwingReLaunchPage.logout(), false)
  assert.equal(throwingReLaunchPage.data.acting, false)

  reset()
  const backPage = createPage()
  backPage.onLoad()
  backPage.goBack()
  assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

  console.log('账号与隐私页控制逻辑测试全部通过')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
