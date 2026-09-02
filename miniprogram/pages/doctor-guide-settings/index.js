const { registerDoctorPage } = require('../../utils/doctor-page')
const {
  isAutoGuideEnabled,
  setAutoGuideEnabled,
  resetPageGuides
} = require('../../utils/guide-state')

function getCurrentDoctor() {
  const currentUser = wx.getStorageSync('current_user')
  return currentUser && typeof currentUser === 'object' ? currentUser : {}
}

registerDoctorPage({
  data: {
    doctorName: '医生',
    doctorEmail: '',
    autoGuideEnabled: true,
    onboardingVisible: true
  },

  onLoad() {
    const currentUser = getCurrentDoctor()
    const fullName = typeof currentUser.full_name === 'string' ? currentUser.full_name.trim() : ''
    const email = typeof currentUser.email === 'string' ? currentUser.email.trim() : ''
    this.setData({
      doctorName: fullName || '医生',
      doctorEmail: email,
      autoGuideEnabled: isAutoGuideEnabled(currentUser)
    })
  },

  onOnboardingVisibilityChange(event) {
    this.setData({ onboardingVisible: Boolean(event && event.detail && event.detail.visible) })
  },

  toggleAutoGuide() {
    const currentUser = getCurrentDoctor()
    const enabled = !this.data.autoGuideEnabled
    setAutoGuideEnabled(currentUser, enabled)
    this.setData({ autoGuideEnabled: enabled })
  },

  restorePageGuides() {
    resetPageGuides(getCurrentDoctor())
    wx.showToast({ title: '页面自动介绍已恢复', icon: 'none' })
  },

  reopenOnboarding() {
    const component = this.selectComponent('#doctor-account-onboarding')
    if (component && typeof component.show === 'function') component.show()
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})
