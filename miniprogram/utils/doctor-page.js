const { ensureResearcherSession } = require('./role-session')

function checkDoctorSession(page, guard) {
  if (page.__doctorSessionRedirectPending === true) return false

  page.__doctorSessionRedirectPending = true
  const guardOptions = {
    onReLaunchSuccess() {
      page.__doctorSessionRedirectPending = true
    },
    onReLaunchFail() {
      page.__doctorSessionRedirectPending = false
    }
  }

  let allowed = false
  try {
    allowed = guard(guardOptions) === true
  } catch (error) {
    page.__doctorSessionRedirectPending = false
  }

  page.__doctorSessionAllowed = allowed
  if (allowed) page.__doctorSessionRedirectPending = false
  return allowed
}

function protectDoctorPage(definition, guard = ensureResearcherSession) {
  const originalOnLoad = definition.onLoad
  const originalOnShow = definition.onShow

  return Object.assign({}, definition, {
    onLoad(...args) {
      const allowed = checkDoctorSession(this, guard)
      if (!allowed || typeof originalOnLoad !== 'function') return undefined
      return originalOnLoad.apply(this, args)
    },

    onShow(...args) {
      if (this.__doctorSessionRedirectPending === true) return undefined
      const allowed = checkDoctorSession(this, guard)
      if (!allowed || typeof originalOnShow !== 'function') return undefined
      return originalOnShow.apply(this, args)
    }
  })
}

function registerDoctorPage(definition) {
  Page(protectDoctorPage(definition))
}

module.exports = {
  protectDoctorPage,
  registerDoctorPage
}
