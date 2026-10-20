const {
  endPatientSession
} = require('./utils/session-privacy')
const { hasValidAnySession } = require('./utils/role-session')
const submissionRecovery = require('./utils/submission-recovery')

App({
  onLaunch() {
    const sessionValues = {}
    const loadedKeys = {}
    const readStorage = (key) => {
      if (!loadedKeys[key]) {
        loadedKeys[key] = true
        sessionValues[key] = wx.getStorageSync(key)
      }

      return sessionValues[key]
    }

    if (hasValidAnySession(readStorage)) {
      this.globalData.isLoggedIn = true
      this.globalData.userInfo = readStorage('current_user')
      submissionRecovery.start(this)
      return
    }

    const app = this
    endPatientSession({
      setLoggedIn(value) {
        app.globalData.isLoggedIn = value
        if (value === false) {
          app.globalData.userInfo = null
        }
      }
    })
    submissionRecovery.start(this)
  },

  onShow() { return submissionRecovery.show(this) },
  onHide() { require('./utils/assistant-draft-guard').clearAssistantDrafts(); require('./utils/companion-transfer').clear(); submissionRecovery.hide(this) },

  globalData: {
    isLoggedIn: false,
    userInfo: null
  }
})
