App({
  onLaunch() {
    const token = wx.getStorageSync('access_token')

    this.globalData.isLoggedIn = Boolean(token)
  },

  globalData: {
    isLoggedIn: false,
    userInfo: null
  }
})