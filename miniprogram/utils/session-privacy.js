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
    return
  }

  wx.removeStorageSync(key)
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
    return
  }

  wx.reLaunch(options)
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
    removeStorage(key)
  } catch (error) {
    // Continue clearing the remaining privacy-sensitive storage keys.
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

function countValidEntries(value) {
  try {
    if (Array.isArray(value)) {
      return value.filter(hasValidContent).length
    }

    if (value && typeof value === 'object') {
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
    !Array.isArray(currentUser)
}

function summarizePatientData(readStorage = defaultReadStorage) {
  const read = storageReader(readStorage)
  const draftCount = [
    'scale_draft_asrs',
    'scale_draft_snap_iv'
  ].filter((key) => hasValidContent(safeRead(read, key))).length

  const resultCount = (
    hasValidContent(safeRead(read, 'scale_latest_result')) ? 1 : 0
  ) + countValidEntries(safeRead(read, 'cognitive_latest_results'))

  const trackingLogs = safeRead(read, 'tracking_local_logs')
  const trackingDayCount = Array.isArray(trackingLogs)
    ? trackingLogs.filter(hasValidContent).length
    : 0

  const pendingCount = [
    'pending_cognitive_result',
    'pending_stroop_result'
  ].filter((key) => hasValidContent(safeRead(read, key))).length +
    countValidEntries(safeRead(read, 'tracking_pending_logs'))

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
  PATIENT_DATA_KEYS.forEach((key) => safeRemove(remove, key))
}

function endPatientSession(options = {}) {
  const settings = options && typeof options === 'object'
    ? options
    : {}
  const remove = storageRemover(settings.removeStorage)
  const setLoggedIn = typeof settings.setLoggedIn === 'function'
    ? settings.setLoggedIn
    : defaultSetLoggedIn

  if (settings.includePatientData !== false) {
    clearPatientData(remove)
  }
  SESSION_KEYS.forEach((key) => safeRemove(remove, key))
  setLoggedIn(false)
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
  reLaunch({ url: '/pages/login/index' })
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
