const { registerPatientPage } = require('../../utils/patient-page')
const { TRACKING_LOGS_KEY } = require('../../utils/tracking-data')
const { buildTrackingTrendModel, createChartPoints } = require('../../utils/tracking-trend')
const {
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
} = require('../../utils/session-privacy')

const METRIC_TABS = [
  { key: 'mood', label: '情绪', color: '#c85c52' },
  { key: 'attention', label: '注意力', color: '#3f8b7f' },
  { key: 'focus', label: '专注时长', color: '#3976b8' }
]

registerPatientPage({
  data: {
    metricTabs: METRIC_TABS,
    activeMetric: 'mood',
    hasData: false,
    completedCount: 0,
    demoMode: false,
    averageValue: 0,
    metricLabel: '情绪评分',
    metricUnit: '分'
  },
  onShow() {
    this._model = buildTrackingTrendModel(wx.getStorageSync(TRACKING_LOGS_KEY))
    this._applyMetric('mood')
  },
  selectMetric(event) {
    const metric = event.currentTarget.dataset.metric
    if (!METRIC_TABS.some((item) => item.key === metric)) return
    this._applyMetric(metric)
  },
  _applyMetric(metric) {
    const series = this._model.series[metric]
    const lease = capturePatientSessionLease()
    this.setData({
      activeMetric: metric,
      hasData: this._model.hasData,
      completedCount: this._model.completedCount,
      demoMode: this._model.demoMode,
      averageValue: series.average,
      metricLabel: series.label,
      metricUnit: series.unit
    }, () => wx.nextTick(() => {
      if (!isPatientSessionLeaseCurrent(lease)) return
      this._drawChart(metric)
    }))
  },
  _drawChart(metric) {
    if (!this._model || !this._model.hasData) return
    const series = this._model.series[metric]
    const tab = METRIC_TABS.find((item) => item.key === metric)
    const minValue = metric === 'focus' ? 0 : 1
    const points = createChartPoints(series.values, 330, 220, 26, series.maxValue, minValue)
    const context = wx.createCanvasContext('trendCanvas', this)
    context.setStrokeStyle('#dce5ec'); context.setLineWidth(1)
    context.beginPath(); context.moveTo(26, 194); context.lineTo(304, 194); context.stroke()
    context.setStrokeStyle(tab.color); context.setLineWidth(3); context.beginPath()
    let drawing = false
    for (const point of points) {
      if (!point) { drawing = false; continue }
      if (!drawing) { context.moveTo(point.x, point.y); drawing = true }
      context.lineTo(point.x, point.y)
    }
    context.stroke()
    context.setFillStyle(tab.color)
    for (const point of points.filter(Boolean)) { context.beginPath(); context.arc(point.x, point.y, 4, 0, Math.PI * 2); context.fill() }
    context.draw()
  },
  onPatientSessionEnded() {
    this._model = null
  },
  goBack() { wx.navigateBack({ delta: 1 }) }
})
