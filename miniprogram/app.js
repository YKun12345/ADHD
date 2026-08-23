const {
  hasValidPatientSession,
  endPatientSession
} = require('./utils/session-privacy')

App({
  onLaunch() {
    const readStorage = (key) => wx.getStorageSync(key)

    if (hasValidPatientSession(readStorage)) {
      this.globalData.isLoggedIn = true
      this.globalData.userInfo = readStorage('current_user')
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
  },

  globalData: {
    isLoggedIn: false,
    userInfo: null
  }
})
