const {
  endPatientSession
} = require('./utils/session-privacy')
const { hasValidAnySession } = require('./utils/role-session')

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
