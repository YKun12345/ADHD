const { ensurePatientSession } = require('./session-privacy')

function protectPatientPage(definition, guard = ensurePatientSession) {
  const originalOnLoad = definition.onLoad
  const originalOnShow = definition.onShow

  return Object.assign({}, definition, {
    onLoad(...args) {
      const allowed = guard()
      this.__patientSessionAllowed = allowed

      if (!allowed || typeof originalOnLoad !== 'function') {
        return undefined
      }

      return originalOnLoad.apply(this, args)
    },

    onShow(...args) {
      if (this.__patientSessionAllowed === false) {
        return undefined
      }

      const allowed = guard()
      this.__patientSessionAllowed = allowed

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
