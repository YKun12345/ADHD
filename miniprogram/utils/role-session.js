const { endPatientSession } = require('./session-privacy')

const VALID_ROLES = Object.freeze(['patient', 'researcher'])

function defaultReadStorage(key) {
  try {
    return wx.getStorageSync(key)
  } catch (error) {
    return undefined
  }
}

function hasValidRoleSession(role, readStorage = defaultReadStorage) {
  if (!VALID_ROLES.includes(role) || typeof readStorage !== 'function') return false

  let token
  let user
  try {
    token = readStorage('access_token')
    user = readStorage('current_user')
  } catch (error) {
    return false
  }

  return (
    typeof token === 'string' &&
    token.trim().length > 0 &&
    user !== null &&
    typeof user === 'object' &&
    !Array.isArray(user) &&
    Number.isInteger(user.id) &&
    user.id > 0 &&
    user.role === role
  )
}

function hasValidAnySession(readStorage = defaultReadStorage) {
  return VALID_ROLES.some((role) => hasValidRoleSession(role, readStorage))
}

function getRoleDestination(user) {
  if (user && user.role === 'patient') return '/pages/home/index'
  if (user && user.role === 'researcher') return '/pages/doctor-home/index'
  return '/pages/login/index'
}

function defaultReLaunch(options) {
  if (typeof wx === 'undefined' || typeof wx.reLaunch !== 'function') return false
  wx.reLaunch(options)
  return true
}

function ensureResearcherSession(options = {}) {
  const readStorage = options.readStorage || defaultReadStorage
  if (hasValidRoleSession('researcher', readStorage)) return true

  endPatientSession({
    removeStorage: options.removeStorage,
    setLoggedIn: options.setLoggedIn,
    getPages: options.getPages,
    includePatientData: true
  })

  const reLaunch = options.reLaunch || defaultReLaunch
  const onSuccess = typeof options.onReLaunchSuccess === 'function'
    ? options.onReLaunchSuccess
    : () => {}
  const onFail = typeof options.onReLaunchFail === 'function'
    ? options.onReLaunchFail
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
  VALID_ROLES,
  hasValidRoleSession,
  hasValidAnySession,
  getRoleDestination,
  ensureResearcherSession
}
