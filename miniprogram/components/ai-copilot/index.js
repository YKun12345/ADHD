const {
  getCopilotConfig,
  buildAiChatUrl
} = require('../../utils/ai-copilot')
const { shouldShowPageGuide, markPageGuideSeen } = require('../../utils/guide-state')

function currentUser() {
  try { return wx.getStorageSync('current_user') || {} } catch (error) { return {} }
}

function releaseTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
}

Component({
  properties: {
    pageKey: {
      type: String,
      value: ''
    }
  },

  data: {
    expanded: false,
    navigating: false,
    guideBubbleVisible: false,
    config: getCopilotConfig('')
  },

  lifetimes: {
    attached() {
      const config = getCopilotConfig(this.data.pageKey)
      this.setData({ config })
      if (!shouldShowPageGuide(currentUser(), this.data.pageKey, undefined, config.version)) return
      this._showTimer = releaseTimer(setTimeout(() => {
        markPageGuideSeen(currentUser(), this.data.pageKey, undefined, config.version)
        this.setData({ guideBubbleVisible: true })
        this._hideTimer = releaseTimer(setTimeout(() => {
          this.setData({ guideBubbleVisible: false })
        }, 6000))
      }, 300))
    },
    detached() {
      clearTimeout(this._showTimer)
      clearTimeout(this._hideTimer)
    }
  },

  methods: {
    closeGuideBubble() {
      clearTimeout(this._hideTimer)
      this.setData({ guideBubbleVisible: false })
    },
    togglePanel() {
      this.setData({
        expanded: !this.data.expanded,
        guideBubbleVisible: false
      })
    },

    closePanel() {
      this.setData({
        expanded: false
      })
    },

    openPageHelp() {
      this.navigateToAi(
        buildAiChatUrl(this.data.pageKey, 'help')
      )
    },

    openFreeQuestion() {
      this.navigateToAi(
        buildAiChatUrl(this.data.pageKey, 'free')
      )
    },

    navigateToAi(url) {
      if (this.data.navigating) return

      this.setData({
        navigating: true
      })
      wx.navigateTo({
        url,
        success: () => {
          this.setData({
            expanded: false
          })
        },
        fail: () => {
          wx.showToast({
            title: '暂时无法打开AI助手',
            icon: 'none'
          })
        },
        complete: () => {
          this.setData({
            navigating: false
          })
        }
      })
    }
  }
})
