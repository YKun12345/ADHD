function readWindowInfo() {
  let info = {}

  if (typeof wx.getWindowInfo === 'function') {
    try {
      info = wx.getWindowInfo() || {}
    } catch (error) {
      info = {}
    }
  }

  if ((!info.statusBarHeight || !info.windowWidth) && typeof wx.getSystemInfoSync === 'function') {
    try {
      const legacyInfo = wx.getSystemInfoSync() || {}
      info = {
        ...legacyInfo,
        ...info,
        statusBarHeight: info.statusBarHeight || legacyInfo.statusBarHeight,
        windowWidth: info.windowWidth || legacyInfo.windowWidth
      }
    } catch (error) {
      // 保留已获取的数据，使用默认导航尺寸兜底。
    }
  }

  return info
}

function readMenuButtonRect() {
  if (typeof wx.getMenuButtonBoundingClientRect !== 'function') return {}

  try {
    return wx.getMenuButtonBoundingClientRect() || {}
  } catch (error) {
    return {}
  }
}

function createNavMetrics(info, menuRect) {
  const statusBarHeight = Number(info.statusBarHeight) || 0
  const windowWidth = Number(info.windowWidth) || 0
  const menuTop = Number(menuRect.top)
  const menuLeft = Number(menuRect.left)
  const menuHeight = Number(menuRect.height)
  const hasValidMenu = Number.isFinite(menuTop) &&
    Number.isFinite(menuLeft) &&
    Number.isFinite(menuHeight) &&
    menuTop >= statusBarHeight &&
    menuLeft > 0 &&
    menuHeight > 0

  const measuredBarHeight = hasValidMenu
    ? (menuTop - statusBarHeight) * 2 + menuHeight
    : 44
  const measuredRightInset = hasValidMenu && windowWidth > menuLeft
    ? windowWidth - menuLeft + 8
    : 12

  return {
    statusBarHeight,
    barHeight: Math.max(44, Math.ceil(measuredBarHeight)),
    rightSafeWidth: Math.max(12, Math.ceil(measuredRightInset))
  }
}

function redirectToFallback(url) {
  if (typeof wx.redirectTo !== 'function') return

  try {
    wx.redirectTo({ url })
  } catch (error) {
    // 已穷尽安全导航方式，留在当前页面。
  }
}

function reLaunchFallback(url) {
  const target = typeof url === 'string' && url
    ? url
    : '/pages/home/index'

  if (typeof wx.reLaunch !== 'function') {
    redirectToFallback(target)
    return
  }

  try {
    wx.reLaunch({
      url: target,
      fail() {
        redirectToFallback(target)
      }
    })
  } catch (error) {
    redirectToFallback(target)
  }
}

function readPageStack() {
  if (typeof getCurrentPages !== 'function') return []

  try {
    const pages = getCurrentPages()
    return Array.isArray(pages) ? pages : []
  } catch (error) {
    return []
  }
}

Component({
  properties: {
    title: { type: String, value: '' },
    showBack: { type: Boolean, value: true },
    rightText: { type: String, value: '' },
    fallbackUrl: { type: String, value: '/pages/home/index' }
  },

  data: {
    statusBarHeight: 0,
    barHeight: 44,
    rightSafeWidth: 12
  },

  lifetimes: {
    attached() {
      this.setData(createNavMetrics(readWindowInfo(), readMenuButtonRect()))
    }
  },

  methods: {
    handleBack() {
      if (!this.properties.showBack) return
      const fallbackUrl = this.properties.fallbackUrl

      if (readPageStack().length <= 1 || typeof wx.navigateBack !== 'function') {
        reLaunchFallback(fallbackUrl)
        return
      }

      try {
        wx.navigateBack({
          delta: 1,
          fail() {
            reLaunchFallback(fallbackUrl)
          }
        })
      } catch (error) {
        reLaunchFallback(fallbackUrl)
      }
    },

    handleRightTap() {
      if (!this.properties.rightText) return
      this.triggerEvent('righttap')
    }
  }
})
