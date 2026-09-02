const { registerPatientPage } = require('../../utils/patient-page')
const { request } = require('../../utils/request')
const { normalizePatientTasks, getTaskNavigationUrl } = require('../../utils/patient-care')

registerPatientPage({
  data: { tasks: [], loading: false, errorText: '', completingId: 0 },
  onShow() { return this.loadTasks() },
  onUnload() { this._loadVersion = (this._loadVersion || 0) + 1 },
  async loadTasks() {
    if (this.data.loading) return
    const version = (this._loadVersion || 0) + 1
    this._loadVersion = version
    this.setData({ loading: true, errorText: '' })
    try {
      const payload = await request({ url: '/care/patient/tasks' })
      if (this._loadVersion !== version) return
      this.setData({ loading: false, tasks: normalizePatientTasks(payload) })
    } catch (error) {
      if (this._loadVersion !== version) return
      this.setData({ loading: false, errorText: error.message || '任务加载失败' })
    }
  },
  openTask(event) {
    const task = this.data.tasks.find((item) => item.id === Number(event.currentTarget.dataset.id))
    const url = getTaskNavigationUrl(task)
    if (!url) return wx.showToast({ title: '暂时无法打开该任务', icon: 'none' })
    wx.navigateTo({ url })
  },
  async completeTask(event) {
    const id = Number(event.currentTarget.dataset.id)
    if (!Number.isInteger(id) || id <= 0 || this.data.completingId) return
    this.setData({ completingId: id })
    try {
      const updated = await request({ url: `/care/patient/tasks/${id}/complete`, method: 'POST' })
      const task = normalizePatientTasks([updated])[0]
      this.setData({ completingId: 0, tasks: this.data.tasks.map((item) => item.id === id ? task : item) })
    } catch (error) {
      this.setData({ completingId: 0 })
      wx.showToast({ title: error.message || '完成状态同步失败', icon: 'none' })
    }
  },
  retryLoad() { return this.loadTasks() }
})
