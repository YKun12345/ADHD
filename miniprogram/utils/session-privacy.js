const {
  API_BASE_URL_KEY,
  resolveApiBaseUrl
} = require('./api-config')

const SESSION_KEYS = [
  'access_token',
  'current_user'
]

const PATIENT_DATA_KEYS = [
  'patient_dashboard_cache',
  'scale_draft_asrs',
  'scale_draft_snap_iv',
  'scale_latest_result',
  'cognitive_latest_results',
  'pending_cognitive_result',
  'pending_stroop_result',
  'tracking_local_logs',
  'tracking_pending_logs'
]

let patientDataRevision = 0

function defaultReadStorage(key) {
  if (typeof wx === 'undefined' || !wx || typeof wx.getStorageSync !== 'function') {
    return undefined
  }

  return wx.getStorageSync(key)
}

function defaultRemoveStorage(key) {
  if (typeof wx === 'undefined' || !wx || typeof wx.removeStorageSync !== 'function') {
    return false
  }

  wx.removeStorageSync(key)
  return true
}

function defaultWriteStorage(key, value) {
  if (typeof wx === 'undefined' || !wx || typeof wx.setStorageSync !== 'function') {
    throw new Error('storage unavailable')
  }

  wx.setStorageSync(key, value)
  return true
}

function defaultSetLoggedIn(value, user = null) {
  if (typeof getApp !== 'function') return true

  try {
    const app = getApp()
    if (app && app.globalData && typeof app.globalData === 'object') {
      app.globalData.isLoggedIn = value
      app.globalData.userInfo = value === true ? user : null
      return true
    }
    return false
  } catch (error) {
    // The app instance can be unavailable while the runtime is starting.
    return false
  }
}

function defaultReLaunch(options) {
  if (typeof wx === 'undefined' || !wx || typeof wx.reLaunch !== 'function') {
    if (options && typeof options.fail === 'function') {
      options.fail(new Error('reLaunch unavailable'))
    }
    return
  }

  wx.reLaunch(options)
}

function defaultGetPages() {
  if (typeof getCurrentPages !== 'function') return []
  return getCurrentPages()
}

function storageReader(readStorage) {
  return typeof readStorage === 'function'
    ? readStorage
    : defaultReadStorage
}

function storageRemover(removeStorage) {
  return typeof removeStorage === 'function'
    ? removeStorage
    : defaultRemoveStorage
}

function storageWriter(writeStorage) {
  return typeof writeStorage === 'function'
    ? writeStorage
    : defaultWriteStorage
}

function safeRead(readStorage, key) {
  return readStorageResult(readStorage, key).value
}

function readStorageResult(readStorage, key) {
  try {
    return {
      ok: true,
      value: readStorage(key)
    }
  } catch (error) {
    return {
      ok: false,
      value: undefined
    }
  }
}

function getPatientDataRevision() {
  return patientDataRevision
}

function advancePatientDataRevision() {
  patientDataRevision += 1
  return patientDataRevision
}

function capturePatientDataLease(readStorage = defaultReadStorage) {
  const read = storageReader(readStorage)
  const apiBaseUrlResult = readStorageResult(read, API_BASE_URL_KEY)

  return {
    revision: getPatientDataRevision(),
    apiBaseUrl: resolveApiBaseUrl(apiBaseUrlResult.value),
    storageReadable: apiBaseUrlResult.ok
  }
}

function isPatientDataLeaseCurrent(
  lease,
  readStorage = defaultReadStorage
) {
  if (!lease || typeof lease !== 'object') return false
  if (lease.storageReadable !== true) return false
  if (lease.revision !== getPatientDataRevision()) return false

  const read = storageReader(readStorage)
  const apiBaseUrlResult = readStorageResult(read, API_BASE_URL_KEY)
  return apiBaseUrlResult.ok &&
    resolveApiBaseUrl(apiBaseUrlResult.value) === lease.apiBaseUrl
}

function capturePatientSessionLease(readStorage = defaultReadStorage) {
  const read = storageReader(readStorage)
  return Object.assign(capturePatientDataLease(read), {
    token: safeRead(read, 'access_token')
  })
}

function isPatientSessionLeaseCurrent(
  lease,
  readStorage = defaultReadStorage
) {
  if (!lease || typeof lease !== 'object') return false
  if (
    typeof lease.token !== 'string' ||
    lease.token.trim().length === 0
  ) {
    return false
  }
  if (!isPatientDataLeaseCurrent(lease, readStorage)) return false

  const read = storageReader(readStorage)
  const currentToken = safeRead(read, 'access_token')
  return typeof currentToken === 'string' &&
    currentToken.trim().length > 0 &&
    currentToken === lease.token
}

function safeRemove(removeStorage, key) {
  try {
    return removeStorage(key) !== false
  } catch (error) {
    // Continue clearing the remaining privacy-sensitive storage keys.
    return false
  }
}

function neutralPageValue(value) {
  if (Array.isArray(value)) return []
  if (value !== null && typeof value === 'object') return null
  if (typeof value === 'string') return ''
  if (typeof value === 'number') return 0
  if (typeof value === 'boolean') return false
  return null
}

function scrubPatientPages(getPages = defaultGetPages) {
  let pages = []

  try {
    pages = getPages()
  } catch (error) {
    return { ok: false, failedPageCount: 1 }
  }

  if (!Array.isArray(pages)) {
    return { ok: false, failedPageCount: 1 }
  }

  let failedPageCount = 0

  pages.forEach((page) => {
    if (!page || typeof page !== 'object') return
    let pageFailed = false

    try {
      page.__patientSessionAllowed = false
    } catch (error) {
      pageFailed = true
    }

    if (page.data && typeof page.data === 'object') {
      const scrubbedData = {}
      Object.keys(page.data).forEach((key) => {
        scrubbedData[key] = neutralPageValue(page.data[key])
      })

      try {
        if (typeof page.setData === 'function') {
          page.setData(scrubbedData)
        } else {
          Object.assign(page.data, scrubbedData)
        }
      } catch (error) {
        pageFailed = true
        Object.keys(scrubbedData).forEach((key) => {
          let updatedThroughRuntime = false

          if (typeof page.setData === 'function') {
            try {
              page.setData({ [key]: scrubbedData[key] })
              updatedThroughRuntime = true
            } catch (setDataError) {
              // Fall back to the in-memory page object below.
            }
          }

          if (!updatedThroughRuntime) {
            try {
              page.data[key] = scrubbedData[key]
            } catch (assignmentError) {
              // The failed page remains counted so callers can destroy it.
            }
          }
        })
      }
    }

    try {
      if (typeof page.onPatientSessionEnded === 'function') {
        page.onPatientSessionEnded()
      }
    } catch (error) {
      pageFailed = true
    }

    if (pageFailed) failedPageCount += 1
  })

  return {
    ok: failedPageCount === 0,
    failedPageCount
  }
}

function containsValidContent(value, seen) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false

  seen.add(value)
  return Object.keys(value).some((key) => (
    containsValidContent(value[key], seen)
  ))
}

function hasValidContent(value) {
  try {
    return containsValidContent(value, new Set())
  } catch (error) {
    return false
  }
}

function countValidMapEntries(value) {
  try {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).filter((key) => (
        hasValidContent(value[key])
      )).length
    }
  } catch (error) {
    return 0
  }

  return 0
}

function hasValidPatientSession(readStorage = defaultReadStorage) {
  const read = storageReader(readStorage)
  const token = safeRead(read, 'access_token')
  const currentUser = safeRead(read, 'current_user')

  return typeof token === 'string' &&
    token.trim().length > 0 &&
    currentUser !== null &&
    typeof currentUser === 'object' &&
    !Array.isArray(currentUser) &&
    Number.isInteger(currentUser.id) &&
    currentUser.id > 0 &&
    currentUser.role === 'patient'
}

function summarizePatientData(readStorage = defaultReadStorage) {
  const read = storageReader(readStorage)
  const draftCount = [
    'scale_draft_asrs',
    'scale_draft_snap_iv'
  ].filter((key) => hasValidContent(safeRead(read, key))).length

  const resultCount = (
    hasValidContent(safeRead(read, 'scale_latest_result')) ? 1 : 0
  ) + countValidMapEntries(safeRead(read, 'cognitive_latest_results'))

  const trackingLogs = safeRead(read, 'tracking_local_logs')
  const trackingDayCount = Array.isArray(trackingLogs)
    ? trackingLogs.filter(hasValidContent).length
    : 0

  const pendingCount = [
    'pending_cognitive_result',
    'pending_stroop_result'
  ].filter((key) => hasValidContent(safeRead(read, key))).length +
    countValidMapEntries(safeRead(read, 'tracking_pending_logs'))

  return {
    draftCount,
    resultCount,
    trackingDayCount,
    pendingCount,
    totalLocalItems: draftCount + resultCount + trackingDayCount + pendingCount
  }
}

function removePatientData(remove) {
  const failedKeys = PATIENT_DATA_KEYS.filter((key) => !safeRemove(remove, key))

  return {
    ok: failedKeys.length === 0,
    failedKeys
  }
}

function clearPatientData(removeStorage = defaultRemoveStorage) {
  advancePatientDataRevision()
  return removePatientData(storageRemover(removeStorage))
}

function endPatientSession(options = {}) {
  const settings = options && typeof options === 'object'
    ? options
    : {}
  const remove = storageRemover(settings.removeStorage)
  const setLoggedIn = typeof settings.setLoggedIn === 'function'
    ? settings.setLoggedIn
    : defaultSetLoggedIn

  advancePatientDataRevision()

  const patientResult = settings.includePatientData !== false
    ? removePatientData(remove)
    : { ok: true, failedKeys: [] }
  const failedSessionKeys = SESSION_KEYS.filter((key) => !safeRemove(remove, key))
  let appStateCleared = true
  try {
    appStateCleared = setLoggedIn(false) !== false
  } catch (error) {
    // Storage cleanup and page scrubbing must still finish.
    appStateCleared = false
  }
  const getPages = typeof settings.getPages === 'function'
    ? settings.getPages
    : defaultGetPages
  const pageResult = scrubPatientPages(getPages)

  const failedKeys = patientResult.failedKeys.concat(failedSessionKeys)
  return {
    ok: failedKeys.length === 0 && pageResult.ok && appStateCleared,
    failedKeys,
    failedPageCount: pageResult.failedPageCount
  }
}

function replacePatientSession(result, options = {}) {
  const settings = options && typeof options === 'object'
    ? options
    : {}
  const endOptions = {
    includePatientData: false,
    removeStorage: settings.removeStorage,
    setLoggedIn: settings.setLoggedIn,
    getPages: settings.getPages
  }
  const setLoggedIn = typeof settings.setLoggedIn === 'function'
    ? settings.setLoggedIn
    : defaultSetLoggedIn
  const preparationResult = endPatientSession(endOptions)

  if (!preparationResult.ok) {
    const preparationError = new Error('旧登录凭证清理失败，请重试')
    preparationError.code = 'SESSION_PREPARE_FAILED'
    preparationError.failedKeys = preparationResult.failedKeys
    preparationError.failedPageCount = preparationResult.failedPageCount
    throw preparationError
  }

  const write = storageWriter(settings.writeStorage)
  try {
    if (write('current_user', result.user) === false) {
      throw new Error('current_user write failed')
    }
    if (write('access_token', result.access_token) === false) {
      throw new Error('access_token write failed')
    }
    if (setLoggedIn(true, result.user) === false) {
      throw new Error('app state write failed')
    }
  } catch (error) {
    const rollbackResult = endPatientSession(endOptions)
    const storageError = new Error(
      rollbackResult.ok
        ? '登录凭证保存失败，请重试'
        : '登录凭证保存及回滚失败，请关闭小程序后重试'
    )
    storageError.code = 'SESSION_STORAGE_FAILED'
    storageError.failedKeys = rollbackResult.failedKeys
    storageError.failedPageCount = rollbackResult.failedPageCount
    throw storageError
  }

  return true
}

function ensurePatientSession(options = {}) {
  const settings = options && typeof options === 'object'
    ? options
    : {}

  if (hasValidPatientSession(settings.readStorage)) {
    return true
  }

  endPatientSession(Object.assign({}, settings, {
    includePatientData: true
  }))
  const reLaunch = typeof settings.reLaunch === 'function'
    ? settings.reLaunch
    : defaultReLaunch
  const onSuccess = typeof settings.onReLaunchSuccess === 'function'
    ? settings.onReLaunchSuccess
    : () => {}
  const onFail = typeof settings.onReLaunchFail === 'function'
    ? settings.onReLaunchFail
    : () => {}

  try {
    reLaunch({
      url: '/pages/login/index',
      success: onSuccess,
      fail: onFail
    })
  } catch (error) {
    onFail(error)
  }
  return false
}

module.exports = {
  SESSION_KEYS,
  PATIENT_DATA_KEYS,
  hasValidPatientSession,
  summarizePatientData,
  clearPatientData,
  endPatientSession,
  replacePatientSession,
  ensurePatientSession,
  getPatientDataRevision,
  advancePatientDataRevision,
  capturePatientDataLease,
  isPatientDataLeaseCurrent,
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
}
