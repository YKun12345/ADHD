const {
  getCopilotConfig,
  buildAiChatUrl
} = require('../../utils/ai-copilot')

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
    config: getCopilotConfig('')
  },

  lifetimes: {
    attached() {
      this.setData({
        config: getCopilotConfig(this.data.pageKey)
      })
    }
  },

  methods: {
    togglePanel() {
      this.setData({
        expanded: !this.data.expanded
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
