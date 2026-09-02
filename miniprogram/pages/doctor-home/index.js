const { request } = require('../../utils/request')
const { registerDoctorPage } = require('../../utils/doctor-page')
const { normalizeDashboard, filterPatients } = require('../../utils/doctor-data')
const {
  endPatientSession,
  reLaunchSafely
} = require('../../utils/session-privacy')

function currentUser() {
  try {
    return wx.getStorageSync('current_user') || {}
  } catch (error) {
    return {}
  }
}

registerDoctorPage({
  data: {
    onboardingVisible: true,
    doctorName: '医生',
    loading: false,
    binding: false,
    bindEmail: '',
    stats: {
      patientCount: 0,
      pendingImagingCount: 0,
      weeklyReportCount: 0
    },
    total: 0,
    allPatients: [],
    patients: [],
    careTotals: { unread: 0, pending: 0 },
    searchQuery: '',
    riskFilters: [
      { value: 'all', label: '全部风险' },
      { value: 'high', label: '高风险' },
      { value: 'medium', label: '中风险' },
      { value: 'low', label: '低风险' }
    ],
    completionFilters: [
      { value: 'all', label: '全部进度' },
      { value: 'incomplete', label: '仍需完成' },
      { value: 'complete', label: '追踪完成' }
    ],
    riskFilter: 'all',
    completionFilter: 'all',
    errorText: ''
  },

  onOnboardingVisibilityChange(event) {
    this.setData({ onboardingVisible: Boolean(event && event.detail && event.detail.visible) })
  },

  onLoad() {
    const user = currentUser()
    this.setData({
      doctorName: user.full_name || user.username || '医生'
    })
  },

  onShow() {
    return this.loadDashboard()
  },

  onUnload() {
    this._dashboardLoadVersion = (this._dashboardLoadVersion || 0) + 1
  },

  async loadDashboard() {
    if (this.data.loading) return
    const version = (this._dashboardLoadVersion || 0) + 1
    this._dashboardLoadVersion = version
    this.setData({ loading: true, errorText: '' })

    try {
      const [stats, patients] = await Promise.all([
        request({ url: '/doctor/dashboard_stats' }),
        request({ url: '/doctor/my_patients' })
      ])
      if (this._dashboardLoadVersion !== version) return
      const dashboard = normalizeDashboard(stats, patients)
      const careSummaries = await Promise.all(dashboard.patients.map(async (patient) => {
        try {
          const summary = await request({ url: `/care/doctor/patient/${patient.patientId}/summary` })
          return {
            patientId: patient.patientId,
            unread: Math.max(0, Number(summary && summary.unread_message_count) || 0),
            pending: Math.max(0, Number(summary && summary.pending_task_count) || 0)
          }
        } catch (error) {
          return { patientId: patient.patientId, unread: 0, pending: 0 }
        }
      }))
      if (this._dashboardLoadVersion !== version) return
      const summaryById = new Map(careSummaries.map((item) => [item.patientId, item]))
      const enrichedPatients = dashboard.patients.map((patient) => ({ ...patient, ...summaryById.get(patient.patientId) }))
      this.setData(Object.assign(dashboard, {
        patients: enrichedPatients,
        allPatients: enrichedPatients,
        careTotals: {
          unread: careSummaries.reduce((sum, item) => sum + item.unread, 0),
          pending: careSummaries.reduce((sum, item) => sum + item.pending, 0)
        },
        loading: false
      }))
    } catch (error) {
      if (this._dashboardLoadVersion !== version) return
      this.setData({
        loading: false,
        errorText: error.message || '医生工作台加载失败'
      })
    }
  },

  applyFilters() {
    this.setData({ patients: filterPatients(this.data.allPatients, {
      query: this.data.searchQuery,
      risk: this.data.riskFilter,
      completion: this.data.completionFilter
    }) })
  },

  onSearchInput(event) {
    this.setData({ searchQuery: event.detail.value })
    this.applyFilters()
  },

  selectRiskFilter(event) {
    const value = event.currentTarget.dataset.value
    if (!['all', 'high', 'medium', 'low'].includes(value)) return
    this.setData({ riskFilter: value })
    this.applyFilters()
  },

  selectCompletionFilter(event) {
    const value = event.currentTarget.dataset.value
    if (!['all', 'complete', 'incomplete'].includes(value)) return
    this.setData({ completionFilter: value })
    this.applyFilters()
  },

  onBindEmailInput(event) {
    if (this.data.binding) return
    this.setData({ bindEmail: event.detail.value })
  },

  async bindPatient() {
    if (this.data.binding) return
    const patientEmail = this.data.bindEmail.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmail)) {
      wx.showToast({ title: '请输入有效的患者邮箱', icon: 'none' })
      return
    }

    this.setData({ binding: true })
    try {
      await request({
        url: '/doctor/bind_patient',
        method: 'POST',
        data: { patient_email: patientEmail }
      })
      this.setData({ bindEmail: '', binding: false })
      wx.showToast({ title: '患者绑定成功', icon: 'success' })
      await this.loadDashboard()
    } catch (error) {
      this.setData({ binding: false })
      wx.showToast({
        title: error.message || '绑定失败',
        icon: 'none',
        duration: 2500
      })
    }
  },

  openPatient(event) {
    const patientId = Number(event.currentTarget.dataset.id)
    if (!Number.isInteger(patientId) || patientId <= 0) return
    wx.navigateTo({
      url: `/pages/doctor-patient/index?patient_id=${patientId}`
    })
  },

  retryLoad() {
    return this.loadDashboard()
  },

  openPrivacySettings() {
    wx.navigateTo({ url: '/pages/doctor-guide-settings/index' })
  },

  logout() {
    endPatientSession({ includePatientData: true })
    reLaunchSafely('/pages/login/index', '退出后返回登录页失败')
  }
})
