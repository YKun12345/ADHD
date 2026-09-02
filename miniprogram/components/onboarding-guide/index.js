const { getOnboardingContent } = require('../../utils/page-guide-content')
const { shouldShowOnboarding, markOnboardingSeen } = require('../../utils/guide-state')

function currentUser() {
  try { return wx.getStorageSync('current_user') || {} } catch (error) { return {} }
}

Component({
  properties: {
    role: { type: String, value: 'patient' },
    forceShow: { type: Boolean, value: false }
  },
  data: {
    visible: false,
    content: getOnboardingContent('patient')
  },
  lifetimes: {
    attached() {
      const user = currentUser()
      const role = this.data.role === 'researcher' ? 'researcher' : 'patient'
      this.setData({
        content: getOnboardingContent(role),
        visible: this.data.forceShow || shouldShowOnboarding(user)
      })
      this.triggerEvent('visibilitychange', { visible: this.data.visible })
    }
  },
  methods: {
    show() {
      const role = this.data.role === 'researcher' ? 'researcher' : 'patient'
      this.setData({ content: getOnboardingContent(role), visible: true })
      this.triggerEvent('visibilitychange', { visible: true })
    },
    dismiss(action) {
      markOnboardingSeen(currentUser())
      this.setData({ visible: false })
      this.triggerEvent('visibilitychange', { visible: false })
      this.triggerEvent('dismiss', { action })
    },
    skip() { this.dismiss('skip') },
    startUsing() { this.dismiss('start') },
    stopTouch() {}
  }
})
