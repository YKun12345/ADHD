const { registerPatientPage } = require('../../utils/patient-page')
const {
  request,
  isPatientSessionError
} = require('../../utils/request')
const {
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
} = require('../../utils/session-privacy')
const {
  SCALE_LATEST_RESULT_KEY,
  buildLocalReport,
  mergeReport
} = require('../../utils/report-data')
const { LATEST_RESULTS_KEY } = require('../../utils/cognitive-results')
const { TRACKING_LOGS_KEY } = require('../../utils/tracking-data')
const { buildCarePathway } = require('../../utils/care-education')

const STEP_ROUTES = Object.freeze({
  scale: '/pages/scale/index',
  cognitive: '/pages/cognitive-center/index',
  tracking: '/pages/tracking/index',
  report: '/pages/report/index'
})

const initialReport = buildLocalReport()
const initialPathway = buildCarePathway(initialReport, false)

registerPatientPage({
  data: {
    patientName: '患者',
    ...initialPathway,
    loading: false,
    statusMessage: ''
  },

  onLoad() {
    const user = wx.getStorageSync('current_user')
    const localReport = this._readLocalReport(user)
    this._localReport = localReport
    this._hasAccount = Boolean(user)
    this.setData({
      patientName: localReport.patientName,
      ...buildCarePathway(localReport, this._hasAccount),
      statusMessage: '',
      loading: false
    })
  },

  onShow() {
    return this.refreshPathway()
  },

  _readLocalReport(user = wx.getStorageSync('current_user')) {
    return buildLocalReport({
      user,
      scaleResult: wx.getStorageSync(SCALE_LATEST_RESULT_KEY),
      cognitiveResults: wx.getStorageSync(LATEST_RESULTS_KEY),
      trackingLogs: wx.getStorageSync(TRACKING_LOGS_KEY)
    })
  },

  async refreshPathway() {
    if (this.data.loading) return

    const user = wx.getStorageSync('current_user')
    const localReport = this._readLocalReport(user)
    this._localReport = localReport
    this._hasAccount = Boolean(user)
    this.setData({
      patientName: localReport.patientName,
      ...buildCarePathway(localReport, this._hasAccount),
      statusMessage: '',
      loading: true
    })
    const lease = capturePatientSessionLease()

    try {
      const response = await request({
        url: '/patient/comprehensive_report',
        method: 'GET'
      })
      if (!isPatientSessionLeaseCurrent(lease)) return
      const report = mergeReport(localReport, response)
      this.setData({
        patientName: report.patientName,
        ...buildCarePathway(report, this._hasAccount),
        statusMessage: '',
        loading: false
      })
    } catch (error) {
      if (
        isPatientSessionError(error) ||
        !isPatientSessionLeaseCurrent(lease)
      ) {
        return
      }
      this.setData({
        patientName: localReport.patientName,
        ...buildCarePathway(localReport, this._hasAccount),
        statusMessage: '暂时无法同步，当前展示本地路径',
        loading: false
      })
    }
  },

  onPatientSessionEnded() {
    this._localReport = null
    this._hasAccount = false
  },

  openStep(event) {
    const stepId = event && event.currentTarget
      ? event.currentTarget.dataset.step
      : ''
    const route = STEP_ROUTES[stepId]
    if (!route) return
    wx.navigateTo({ url: route })
  },

  openAi() {
    wx.navigateTo({ url: '/pages/ai-chat/index' })
  },

  openEducation() {
    wx.navigateTo({ url: '/pages/education/index' })
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})
