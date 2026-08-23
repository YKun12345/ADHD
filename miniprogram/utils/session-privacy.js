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

function defaultSetLoggedIn(value) {
  if (typeof getApp !== 'function') return

  try {
    const app = getApp()
    if (app && app.globalData && typeof app.globalData === 'object') {
      app.globalData.isLoggedIn = value
      if (value === false) {
        app.globalData.userInfo = null
      }
    }
  } catch (error) {
    // The app instance can be unavailable while the runtime is starting.
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

  try {
    const pages = getCurrentPages()
    return Array.isArray(pages) ? pages : []
  } catch (error) {
    return []
  }
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

function safeRead(readStorage, key) {
  try {
    return readStorage(key)
  } catch (error) {
    return undefined
  }
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
    return
  }

  if (!Array.isArray(pages)) return

  pages.forEach((page) => {
    if (!page || typeof page !== 'object') return

    page.__patientSessionAllowed = false

    try {
      if (typeof page.onPatientSessionEnded === 'function') {
        page.onPatientSessionEnded()
      }
    } catch (error) {
      // Continue scrubbing this page even if its optional cleanup hook fails.
    }

    if (!page.data || typeof page.data !== 'object') return

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
      // A failing page must not prevent the remaining page stack from clearing.
    }
  })
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

function clearPatientData(removeStorage = defaultRemoveStorage) {
  const remove = storageRemover(removeStorage)
  const failedKeys = PATIENT_DATA_KEYS.filter((key) => !safeRemove(remove, key))

  return {
    ok: failedKeys.length === 0,
    failedKeys
  }
}

function endPatientSession(options = {}) {
  const settings = options && typeof options === 'object'
    ? options
    : {}
  const remove = storageRemover(settings.removeStorage)
  const setLoggedIn = typeof settings.setLoggedIn === 'function'
    ? settings.setLoggedIn
    : defaultSetLoggedIn

  const patientResult = settings.includePatientData !== false
    ? clearPatientData(remove)
    : { ok: true, failedKeys: [] }
  const failedSessionKeys = SESSION_KEYS.filter((key) => !safeRemove(remove, key))
  try {
    setLoggedIn(false)
  } catch (error) {
    // Storage cleanup and page scrubbing must still finish.
  }
  const getPages = typeof settings.getPages === 'function'
    ? settings.getPages
    : defaultGetPages
  scrubPatientPages(getPages)

  const failedKeys = patientResult.failedKeys.concat(failedSessionKeys)
  return {
    ok: failedKeys.length === 0,
    failedKeys
  }
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
  ensurePatientSession
}
