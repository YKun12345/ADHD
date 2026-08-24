function showToastSafely(title) {
  try {
    if (
      typeof wx !== 'undefined' &&
      wx &&
      typeof wx.showToast === 'function'
    ) {
      wx.showToast({
        title,
        icon: 'none'
      })
    }
  } catch (error) {
    // Navigation recovery must not create a second runtime failure.
  }
}

function reLaunchSafely(url, failureTitle = '页面跳转失败，请重试') {
  let failureReported = false
  const reportFailure = () => {
    if (failureReported) return
    failureReported = true
    showToastSafely(failureTitle)
  }

  try {
    if (
      typeof wx === 'undefined' ||
      !wx ||
      typeof wx.reLaunch !== 'function'
    ) {
      reportFailure()
      return false
    }

    wx.reLaunch({
      url,
      fail: reportFailure
    })
    return true
  } catch (error) {
    reportFailure()
    return false
  }
}

module.exports = {
  reLaunchSafely
}
