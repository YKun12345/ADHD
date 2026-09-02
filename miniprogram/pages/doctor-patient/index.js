const { request } = require('../../utils/request')
const { registerDoctorPage } = require('../../utils/doctor-page')
const {
  normalizePatientReport,
  normalizeMessages,
  normalizeDoctorTasks,
  normalizeAiLogs,
  isValidPatientId,
  validateMessage,
  validateTaskDraft
} = require('../../utils/doctor-data')
const { createClientMessageId } = require('../../utils/patient-care')

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
    messages: [],
    tasks: [],
    aiLogs: [],
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
    this._patientLoadVersion = (this._patientLoadVersion || 0) + 1
  },

  async loadPatientData() {
    const patientId = this.data.patientId
    if (!isValidPatientId(patientId) || this.data.loading) return
    const version = (this._patientLoadVersion || 0) + 1
    this._patientLoadVersion = version
    this.setData({ loading: true, errorText: '' })

    try {
      const [reportPayload, messagePayload, taskPayload, aiPayload] = await Promise.all([
        request({ url: `/doctor/patient/${patientId}/report` }),
        request({ url: `/care/doctor/patient/${patientId}/messages` }),
        request({ url: `/care/doctor/patient/${patientId}/tasks` }),
        request({ url: `/care/doctor/patient/${patientId}/ai_logs` })
      ])
      if (this._patientLoadVersion !== version) return
      this.setData({
        loading: false,
        report: normalizePatientReport(reportPayload),
        messages: normalizeMessages(messagePayload),
        tasks: normalizeDoctorTasks(taskPayload),
        aiLogs: normalizeAiLogs(aiPayload)
      })
      request({ url: `/care/doctor/patient/${patientId}/messages/read`, method: 'POST' }).catch(() => {})
    } catch (error) {
      if (this._patientLoadVersion !== version) return
      this.setData({
        loading: false,
        errorText: error.message || '患者报告加载失败'
      })
    }
  },

  onMessageInput(event) {
    if (this.data.sending) return
    const messageInput = event.detail.value
    if (messageInput !== this.data.messageInput) this._messageClientId = ''
    this.setData({ messageInput })
  },

  onInputFocus() { this.setData({ inputFocused: true }) },
  onInputBlur() { this.setData({ inputFocused: false }) },

  async sendMessage() {
    if (this.data.sending) return
    const validation = validateMessage(this.data.messageInput)
    if (!validation.ok) {
      wx.showToast({ title: validation.message, icon: 'none' })
      return
    }

    const patientId = this.data.patientId
    if (!isValidPatientId(patientId)) return
    const clientMessageId = this._messageClientId || createClientMessageId()
    this._messageClientId = clientMessageId
    this.setData({ sending: true })
    try {
      const created = await request({
        url: `/care/doctor/patient/${patientId}/messages`,
        method: 'POST',
        data: { content: validation.content, client_message_id: clientMessageId }
      })
      const appended = normalizeMessages([created])
      this.setData({
        sending: false,
        messageInput: '',
        messages: this.data.messages.concat(appended)
      })
      this._messageClientId = ''
      wx.showToast({ title: '消息已发送', icon: 'success' })
    } catch (error) {
      this.setData({ sending: false })
      wx.showToast({
        title: error.message || '消息发送失败',
        icon: 'none',
        duration: 2500
      })
    }
  },

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
    if (this.data.creatingTask) return
    const validation = validateTaskDraft({
      taskType: this.data.taskType,
      title: this.data.taskTitle,
      description: this.data.taskDescription,
      dueDate: this.data.taskDueDate
    })
    if (!validation.ok) return wx.showToast({ title: validation.message, icon: 'none' })
    this.setData({ creatingTask: true })
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
      this.setData({
        creatingTask: false,
        taskTitle: '',
        taskDescription: '',
        taskDueDate: '',
        tasks: [normalizeDoctorTasks([created])[0]].concat(this.data.tasks)
      })
      wx.showToast({ title: '任务已下发', icon: 'success' })
    } catch (error) {
      this.setData({ creatingTask: false })
      wx.showToast({ title: error.message || '任务下发失败', icon: 'none' })
    }
  },

  retryLoad() {
    return this.loadPatientData()
  }
})
