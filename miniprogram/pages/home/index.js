const { registerPatientPage } = require('../../utils/patient-page')
const { request } = require('../../utils/request')
const {
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
} = require('../../utils/session-privacy')
const {
  createLocalDashboard,
  normalizeDashboardStatus,
  buildHomeTasks,
  buildQuickEntries
} = require('../../utils/home-dashboard')

const MODULE_PRESENTATION = Object.freeze({
  plan: { iconName: 'plan', iconShape: 'orbit' },
  scale: { iconName: 'scale', iconShape: 'sheet' },
  cognitive: { iconName: 'cognitive', iconShape: 'lens' },
  tracking: { iconName: 'tracking', iconShape: 'lens' },
  report: { iconName: 'report', iconShape: 'sheet' },
  ai: { iconName: 'ai', iconShape: 'orb' },
  pathway: { iconName: 'pathway', iconShape: 'orbit' },
  education: { iconName: 'education', iconShape: 'book' }
})

function decorateHomeItems(items = []) {
  return items.map((item) => ({
    ...item,
    ...(MODULE_PRESENTATION[item.id] || MODULE_PRESENTATION.plan)
  }))
}

registerPatientPage({
  data: {
    userName: '患者',
    currentDay: 1,
    totalDays: 14,
    completedDays: [],
    completedCount: 0,
    progressPercent: 0,
    dashboardSource: 'local',
    sourceLabel: '本地计划',
    statusMessage: '',
    loadingDashboard: false,
    tasks: decorateHomeItems(buildHomeTasks()),
    quickEntries: decorateHomeItems(buildQuickEntries())
  },

  onLoad() {
    const user = wx.getStorageSync('current_user')

    if (!user) {
      return
    }

    const patientProfile = user.patient_profile || {}
    const patientType = String(
      patientProfile.patient_type || ''
    ).toLowerCase()

    this.setData({
      ...(user.full_name
        ? { userName: user.full_name }
        : {}),
      tasks: decorateHomeItems(buildHomeTasks(patientType)),
      quickEntries: decorateHomeItems(buildQuickEntries(patientType))
    })
  },

  onShow() {
    return this.refreshDashboard()
  },

  async refreshDashboard() {
    const cache = wx.getStorageSync('patient_dashboard_cache')
    const localDashboard = createLocalDashboard(cache)

    this.setData({
      ...localDashboard,
      statusMessage: '',
      loadingDashboard: true
    })
    const lease = capturePatientSessionLease()

    try {
      const response = await request({
        url: '/patient/dashboard_status',
        method: 'GET'
      })
      if (!isPatientSessionLeaseCurrent(lease)) return
      const serverDashboard = normalizeDashboardStatus(response)

      this.setData({
        ...serverDashboard,
        statusMessage: '',
        loadingDashboard: false
      })

      wx.setStorageSync('patient_dashboard_cache', {
        currentDay: serverDashboard.currentDay,
        completedDays: serverDashboard.completedDays
      })
    } catch (error) {
      if (!isPatientSessionLeaseCurrent(lease)) return
      this.setData({
        statusMessage: '暂时无法同步，当前展示本地计划',
        loadingDashboard: false
      })
    }
  },

  openHomeItem(collection, id) {
    const item = collection.find((entry) => entry.id === id)

    if (!item || !item.available || !item.url) {
      wx.showToast({
        title: '该功能正在按计划开发',
        icon: 'none'
      })
      return
    }

    wx.navigateTo({
      url: item.url
    })
  },

  handleTaskTap(event) {
    this.openHomeItem(
      this.data.tasks,
      event.currentTarget.dataset.id
    )
  },

  handleEntryTap(event) {
    this.openHomeItem(
      this.data.quickEntries,
      event.currentTarget.dataset.id
    )
  },

  openServerSettings() {
    wx.navigateTo({
      url: '/pages/server-settings/index'
    })
  },

  openPrivacySettings() {
    wx.navigateTo({
      url: '/pages/privacy-settings/index'
    })
  }
})
