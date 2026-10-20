const { request } = require('../../utils/request')
const { registerDoctorPage } = require('../../utils/doctor-page')
const {
  normalizePatientReport,
  normalizeDoctorTasks,
  isValidPatientId,
  validateTaskDraft
} = require('../../utils/doctor-data')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')

function returnToDoctorHome() {
  const fallback = () => wx.reLaunch({ url: '/pages/doctor-home/index' })
  try {
    wx.navigateBack({ delta: 1, fail: fallback })
  } catch (error) {
    fallback()
  }
}

registerDoctorPage({
  data: {
    patientId: 0,
    inputFocused: false,
    loading: false,
    sending: false,
    report: null,
    detailsAvailable: false,
    patientName: '', patientEmail: '', reportAccessDenied: false,
    messages: [],
    tasks: [],
    aiLogs: [],
    careAccessDenied: false,
    messageInput: '',
    taskTypes: [
      { value: 'scale', label: '量表任务' },
      { value: 'cognitive', label: '认知任务' },
      { value: 'tracking', label: '每日追踪任务' },
      { value: 'report_review', label: '报告复核任务' }
    ],
    taskType: 'scale',
    taskTitle: '',
    taskDescription: '',
    taskDueDate: '',
    creatingTask: false,
    errorText: ''
  },

  onLoad(options) {
    if (!this._hasCurrentSession()) return
    const rawPatientId = options && options.patient_id
    if (!isValidPatientId(rawPatientId)) {
      wx.showToast({ title: '患者编号无效', icon: 'none' })
      returnToDoctorHome()
      return
    }
    this.setData({ patientId: Number(rawPatientId) })
    return this.loadPatientData()
  },

  onUnload() {
    this._ended = true
    this._clearPatientData()
  },

  onShow() { this._hidden = false; if (this.data.patientId) return this.loadPatientData() },

  onHide() {
    this._hidden = true
    this._clearPatientData()
  },

  onPatientSessionEnded() { this._ended = true; this._clearPatientData() },

  _clearPatientData() {
    this._patientLoadVersion = (this._patientLoadVersion || 0) + 1
    this._messageClientId = ''
    this.setData({ loading: false, sending: false, creatingTask: false, messageInput: '', inputFocused: false,
      taskTitle: '', taskDescription: '', taskDueDate: '', report: null, detailsAvailable: false,
      patientName: '', patientEmail: '', messages: [], tasks: [], aiLogs: [], errorText: '' })
  },

  _hasCurrentSession() {
    let user
    try { user = wx.getStorageSync('current_user') } catch (_) { user = null }
    if (!this._entryLease) { this._entryLease = capturePatientSessionLease(); this._entryActorId = user && user.id }
    const valid = !this._hidden && !this._ended && user && user.role === 'researcher' &&
      Number.isInteger(user.id) && user.id > 0 && user.id === this._entryActorId && isPatientSessionLeaseCurrent(this._entryLease)
    if (!valid) this._clearPatientData()
    return Boolean(valid)
  },

  async loadPatientData() {
    const patientId = this.data.patientId
    if (!this._hasCurrentSession() || !isValidPatientId(patientId) || this.data.loading) return
    const version = (this._patientLoadVersion || 0) + 1
    this._patientLoadVersion = version
    this.setData({ loading: true, errorText: '' })

    try {
      const optionalCareRead = async url => {
        try { return await request({ url }) }
        catch (error) {
          if (error.statusCode === 403) return { items: [], scope_denied: true, access_error: error.message }
          throw error
        }
      }
      const [reportPayload, taskPayload] = await Promise.all([
        optionalCareRead(`/doctor/patient/${patientId}/report`),
        optionalCareRead(`/care/doctor/patient/${patientId}/tasks`)
      ])
      if (!this._hasCurrentSession() || this._patientLoadVersion !== version) return
      let metadata = null
      if (reportPayload.scope_denied) {
        const patients = await optionalCareRead('/doctor/my_patients')
        if (!this._hasCurrentSession() || this._patientLoadVersion !== version) return
        metadata = (patients.items || []).find(row => row.patient_id === patientId)
      }
      if (reportPayload.scope_denied && taskPayload.scope_denied && !metadata) {
        throw new Error(reportPayload.access_error || '当前共享授权无效，请刷新核对')
      }
      const report = reportPayload.scope_denied ? null : normalizePatientReport(reportPayload)
      this.setData({
        loading: false,
        report, detailsAvailable: true, reportAccessDenied: reportPayload.scope_denied === true,
        patientName: report ? report.patientName : metadata && metadata.patient_name || `共享档案 #${patientId}`,
        patientEmail: report ? report.patientEmail : metadata && metadata.patient_email || '基础资料未共享',
        messages: [],
        tasks: normalizeDoctorTasks(taskPayload),
        aiLogs: [],
        careAccessDenied: Boolean(taskPayload.scope_denied)
      })
    } catch (error) {
      if (!this._hasCurrentSession() || this._patientLoadVersion !== version) return
      this.setData({
        loading: false,
        report: null, detailsAvailable: false, patientName: '', patientEmail: '', messages: [], tasks: [], aiLogs: [], careAccessDenied: true,
        errorText: error.message || '患者报告加载失败'
      })
    }
  },

  onMessageInput(event) {
    this.setData({ messageInput: '' })
  },

  openImagingReports() { if (this._hasCurrentSession() && isValidPatientId(this.data.patientId)) wx.navigateTo({ url: `/pages/imaging-reports/index?patient_id=${this.data.patientId}` }) },
  openFollowupSummary() { if (this._hasCurrentSession() && isValidPatientId(this.data.patientId)) wx.navigateTo({ url: `/pages/followup-summary/index?patient_id=${this.data.patientId}` }) },

  openAssessments() {
    if (this._hasCurrentSession() && isValidPatientId(this.data.patientId)) wx.navigateTo({ url: `/pages/assessments/index?patient_id=${this.data.patientId}` })
  },

  onInputFocus() { this.setData({ inputFocused: true }) },
  onInputBlur() { this.setData({ inputFocused: false }) },

  openSharedMessages() {
    if (!this._hasCurrentSession() || !isValidPatientId(this.data.patientId)) return
    wx.navigateTo({ url: `/pages/shared-messages/index?patient_id=${this.data.patientId}` })
  },

  // Compatibility handler only opens the relationship-bound composer.
  sendMessage() { return this.openSharedMessages() },

  selectTaskType(event) {
    if (this.data.creatingTask) return
    const taskType = event.currentTarget.dataset.value
    if (this.data.taskTypes.some((item) => item.value === taskType)) this.setData({ taskType })
  },

  onTaskFieldInput(event) {
    if (this.data.creatingTask) return
    const field = event.currentTarget.dataset.field
    if (['taskTitle', 'taskDescription'].includes(field)) this.setData({ [field]: event.detail.value })
  },

  onTaskDueDateChange(event) {
    if (!this.data.creatingTask) this.setData({ taskDueDate: event.detail.value })
  },

  async createTask() {
    if (!this._hasCurrentSession()) return
    if (this.data.careAccessDenied) { wx.showToast({ title: '当前共享范围不包含任务', icon: 'none' }); return }
    if (this.data.creatingTask) return
    const validation = validateTaskDraft({
      taskType: this.data.taskType,
      title: this.data.taskTitle,
      description: this.data.taskDescription,
      dueDate: this.data.taskDueDate
    })
    if (!validation.ok) return wx.showToast({ title: validation.message, icon: 'none' })
    this.setData({ creatingTask: true })
    const version = this._patientLoadVersion
    try {
      const created = await request({
        url: `/care/doctor/patient/${this.data.patientId}/tasks`,
        method: 'POST',
        data: {
          task_type: validation.taskType,
          task_title: validation.title,
          task_description: validation.description,
          due_at: validation.dueDate ? `${validation.dueDate}T23:59:59+08:00` : null
        }
      })
      if (!this._hasCurrentSession() || version !== this._patientLoadVersion) return
      this.setData({
        creatingTask: false,
        taskTitle: '',
        taskDescription: '',
        taskDueDate: '',
        tasks: [normalizeDoctorTasks([created])[0]].concat(this.data.tasks)
      })
      wx.showToast({ title: '任务已下发', icon: 'success' })
    } catch (error) {
      if (!this._hasCurrentSession() || version !== this._patientLoadVersion) return
      this.setData({ creatingTask: false })
      wx.showToast({ title: error.message || '任务下发失败', icon: 'none' })
    }
  },

  retryLoad() {
    return this.loadPatientData()
  }
})
