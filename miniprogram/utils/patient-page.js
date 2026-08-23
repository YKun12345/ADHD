const { ensurePatientSession } = require('./session-privacy')

function checkPatientSession(page, guard) {
  if (page.__patientSessionRedirectPending === true) {
    return false
  }

  page.__patientSessionRedirectPending = true

  const guardOptions = {
    onReLaunchSuccess() {
      page.__patientSessionRedirectPending = true
    },
    onReLaunchFail() {
      page.__patientSessionRedirectPending = false
    }
  }

  let allowed = false
  try {
    allowed = guard(guardOptions) === true
  } catch (error) {
    page.__patientSessionRedirectPending = false
  }

  page.__patientSessionAllowed = allowed
  if (allowed) {
    page.__patientSessionRedirectPending = false
  }

  return allowed
}

function protectPatientPage(definition, guard = ensurePatientSession) {
  const originalOnLoad = definition.onLoad
  const originalOnShow = definition.onShow

  return Object.assign({}, definition, {
    onLoad(...args) {
      const allowed = checkPatientSession(this, guard)

      if (!allowed || typeof originalOnLoad !== 'function') {
        return undefined
      }

      return originalOnLoad.apply(this, args)
    },

    onShow(...args) {
      if (this.__patientSessionRedirectPending === true) {
        return undefined
      }

      const allowed = checkPatientSession(this, guard)

      if (!allowed || typeof originalOnShow !== 'function') {
        return undefined
      }

      return originalOnShow.apply(this, args)
    }
  })
}

function registerPatientPage(definition) {
  Page(protectPatientPage(definition))
}

module.exports = {
  protectPatientPage,
  registerPatientPage
}
