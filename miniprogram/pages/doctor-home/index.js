const { request } = require('../../utils/request')
const { registerDoctorPage } = require('../../utils/doctor-page')
const { normalizeDashboard, filterPatients } = require('../../utils/doctor-data')
const {
  endPatientSession,
  reLaunchSafely,
  summarizePatientData,
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
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
    accountMenuVisible: false,
    accountMenuTop: 100,
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
    pendingMessageCount: 0,
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
    statisticFilter: 'patients',
    listTitle: '我的用户',
    listNote: '',
    errorText: ''
  },

  onOnboardingVisibilityChange(event) {
    this.setData({ onboardingVisible: Boolean(event && event.detail && event.detail.visible) })
  },

  onLoad(options = {}) {
    if (!this._hasCurrentSession()) return
    const user = currentUser()
    this.setData({
      doctorName: user.full_name || user.username || '医生',
      showPatientsSection: options.section === 'patients'
    })
    try {
      const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const rect = typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : {}
      this.setData({ accountMenuTop: Math.max((Number(info.statusBarHeight) || 24) + 52, (Number(rect.bottom) || 0) + 12) })
    } catch (_) { /* Keep the safe default below the navigation bar. */ }
  },

  onShow() {
    this._hidden = false
    if (!this._hasCurrentSession()) return
    const user = currentUser()
    this.setData({ pendingMessageCount: summarizePatientData().pendingCount, doctorName: user.full_name || user.username || '医生' })
    return this.loadDashboard()
  },

  onUnload() {
    this._ended = true
    this._clearDashboard()
  },

  onHide() { this._hidden = true; this._clearDashboard() },
  onPatientSessionEnded() { this._ended = true; this._clearDashboard() },

  _clearDashboard() {
    this._dashboardLoadVersion = (this._dashboardLoadVersion || 0) + 1
    this.setData({ accountMenuVisible: false, doctorName: '', loading: false, binding: false, bindEmail: '', patients: [], allPatients: [],
      total: 0, pendingMessageCount: 0, stats: { patientCount: 0, pendingImagingCount: 0, weeklyReportCount: 0 },
      careTotals: { unread: 0, pending: 0 }, searchQuery: '', errorText: '' })
  },

  _hasCurrentSession() {
    const user = currentUser()
    if (!this._entryLease) { this._entryLease = capturePatientSessionLease(); this._entryActorId = user.id }
    const valid = !this._hidden && !this._ended && user.role === 'researcher' && Number.isInteger(user.id) &&
      user.id > 0 && user.id === this._entryActorId && isPatientSessionLeaseCurrent(this._entryLease)
    if (!valid) this._clearDashboard()
    return Boolean(valid)
  },

  async loadDashboard() {
    if (!this._hasCurrentSession() || this.data.loading) return
    const version = (this._dashboardLoadVersion || 0) + 1
    this._dashboardLoadVersion = version
    this.setData({ loading: true, errorText: '' })

    try {
      const [stats, patients] = await Promise.all([
        request({ url: '/doctor/dashboard_stats' }),
        request({ url: '/doctor/my_patients' })
      ])
      if (!this._hasCurrentSession() || this._dashboardLoadVersion !== version) return
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
      if (!this._hasCurrentSession() || this._dashboardLoadVersion !== version) return
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
      this.applyFilters()
    } catch (error) {
      if (!this._hasCurrentSession() || this._dashboardLoadVersion !== version) return
      this.setData({
        loading: false,
        patients: [], allPatients: [], total: 0,
        stats: { patientCount: 0, pendingImagingCount: 0, weeklyReportCount: 0 },
        careTotals: { unread: 0, pending: 0 },
        errorText: error.message || '医生工作台加载失败'
      })
    }
  },

  applyFilters() {
    this.setData({ patients: filterPatients(this.data.allPatients, {
      query: this.data.searchQuery,
      risk: this.data.riskFilter,
      completion: this.data.completionFilter,
      statistic: this.data.statisticFilter
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
    if (!this._hasCurrentSession()) return
    if (this.data.binding) return
    const patientEmail = this.data.bindEmail.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmail)) {
      wx.showToast({ title: '请输入有效的患者邮箱', icon: 'none' })
      return
    }

    this.setData({ binding: true })
    const version = this._dashboardLoadVersion
    try {
      await request({
        url: '/care/relationships/invitations',
        method: 'POST',
        data: { target_email: patientEmail, scope: ['profile', 'assessment', 'tracking', 'care', 'imaging'], purpose: 'clinical_sharing', expires_at: new Date(Date.now() + 90 * 86400000).toISOString() }
      })
      if (!this._hasCurrentSession() || version !== this._dashboardLoadVersion) return
      this.setData({ bindEmail: '', binding: false })
      wx.showToast({ title: '邀请已发出，等待对方确认', icon: 'none' })
      await this.loadDashboard()
    } catch (error) {
      if (!this._hasCurrentSession() || version !== this._dashboardLoadVersion) return
      this.setData({ binding: false })
      wx.showToast({
        title: error.message || '绑定失败',
        icon: 'none',
        duration: 2500
      })
    }
  },

  openPatient(event) {
    if (!this._hasCurrentSession()) return
    const patientId = Number(event.currentTarget.dataset.id)
    if (!Number.isInteger(patientId) || patientId <= 0) return
    wx.navigateTo({
      url: `/pages/doctor-patient/index?patient_id=${patientId}`
    })
  },

  openStatistic(event) {
    if (!this._hasCurrentSession()) return false
    const key = event.currentTarget.dataset.stat
    if (key === 'messages') { this.openSharedMessages(); return true }
    const views = {
      patients: ['我的用户', '选择用户查看已共享的资料。'],
      reports: ['本周新报告', '列出近7天有量表报告的用户；点开查看报告，同一用户可能有多份。'],
      imaging: ['待完善影像', '仅列出已共享影像范围且尚无影像记录的用户。上传和分析请在电脑医生端完成。'],
      tasks: ['待办用户任务', '选择有未完成任务的用户，在详情页查看医生任务。']
    }
    if (!views[key]) return false
    this.setData({ showPatientsSection: true, statisticFilter: key, listTitle: views[key][0], listNote: views[key][1],
      searchQuery: '', riskFilter: 'all', completionFilter: 'all' })
    this.applyFilters()
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 200 })
    return true
  },

  showAllPatients() { return this.openStatistic({ currentTarget: { dataset: { stat: 'patients' } } }) },

  retryLoad() {
    return this.loadDashboard()
  },

  openPatientList() { if (this._hasCurrentSession()) wx.reLaunch({ url: '/pages/doctor-home/index?section=patients' }) },
  openCommunication() { if (this._hasCurrentSession()) wx.reLaunch({ url: '/pages/workspace/index?section=communication' }) },

  openPrivacySettings() {
    if (this._hasCurrentSession()) { this.setData({ accountMenuVisible: false }); wx.navigateTo({ url: '/pages/doctor-guide-settings/index' }) }
  },
  toggleAccountMenu() { if (this._hasCurrentSession()) this.setData({ accountMenuVisible: !this.data.accountMenuVisible }) },
  closeAccountMenu() { this.setData({ accountMenuVisible: false }) },
  openCareAttention() { if (this._hasCurrentSession()) wx.navigateTo({ url: '/pages/care-attention/index' }) },
  openTransfers() { if (this._hasCurrentSession()) wx.navigateTo({ url: '/pages/responsibility-transfers/index' }) },
  openTransferredWork() { if (this._hasCurrentSession()) wx.navigateTo({ url: '/pages/transferred-work/index' }) },
  openSharedMessages() { if (this._hasCurrentSession()) wx.navigateTo({ url: '/pages/shared-messages/index' }) },
  openSubmissionQueue() { if (this._hasCurrentSession()) wx.navigateTo({ url: '/pages/submission-queue/index' }) },

  logout() {
    if (!this._hasCurrentSession()) return
    this.setData({ accountMenuVisible: false })
    const finish = () => {
      if (!this._hasCurrentSession()) return
      endPatientSession({ includePatientData: true })
      this.onPatientSessionEnded()
      reLaunchSafely('/pages/login/index', '退出后返回登录页失败')
    }
    if (summarizePatientData().pendingCount > 0) {
      if (this._logoutConfirmPending) return
      this._logoutConfirmPending = true
      wx.showModal({
        title: '还有待确认业务记录',
        content: '本机仍有未同步或未确认的消息、关注、交接、审核、补问、报告或计划操作，退出后将清除，可能尚未保存到服务器。可先取消并到待同步页面核对；确定退出并清除吗？',
        confirmText: '退出并清除',
        success: result => { this._logoutConfirmPending = false; if (result.confirm) finish() },
        fail: () => { this._logoutConfirmPending = false }
      })
      return
    }
    finish()
  }
})
