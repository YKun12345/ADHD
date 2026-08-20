const { request } = require('../../utils/request')
const {
  createLocalDashboard,
  normalizeDashboardStatus,
  buildHomeTasks,
  buildQuickEntries
} = require('../../utils/home-dashboard')

Page({
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
    tasks: buildHomeTasks(),
    quickEntries: buildQuickEntries()
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
      tasks: buildHomeTasks(patientType),
      quickEntries: buildQuickEntries(patientType)
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

    try {
      const response = await request({
        url: '/patient/dashboard_status',
        method: 'GET'
      })
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
  }
})
