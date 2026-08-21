const { request } = require('../../utils/request')
const {
  SCALE_LATEST_RESULT_KEY,
  buildLocalReport,
  mergeReport,
  createRadarGeometry
} = require('../../utils/report-data')
const {
  LATEST_RESULTS_KEY
} = require('../../utils/cognitive-results')
const {
  TRACKING_LOGS_KEY
} = require('../../utils/tracking-data')
const {
  createChartPoints
} = require('../../utils/tracking-trend')

const TASK_ROUTES = Object.freeze({
  scale: '/pages/scale/index',
  cognitive: '/pages/cognitive-center/index',
  tracking: '/pages/tracking/index'
})

const initialReport = buildLocalReport()

function drawPolygon(context, points, closePath = true) {
  if (!Array.isArray(points) || !points.length) return
  context.beginPath()
  context.moveTo(points[0].x, points[0].y)
  for (const point of points.slice(1)) {
    context.lineTo(point.x, point.y)
  }
  if (closePath) context.closePath()
}

Page({
  data: {
    ...initialReport,
    loading: false
  },

  onLoad() {
    const localReport = this._readLocalReport()
    this._localReport = localReport
    this.setData(localReport)
  },

  onShow() {
    return this.refreshReport()
  },

  _readLocalReport() {
    return buildLocalReport({
      user: wx.getStorageSync('current_user'),
      scaleResult: wx.getStorageSync(SCALE_LATEST_RESULT_KEY),
      cognitiveResults: wx.getStorageSync(LATEST_RESULTS_KEY),
      trackingLogs: wx.getStorageSync(TRACKING_LOGS_KEY)
    })
  },

  async refreshReport() {
    if (this.data.loading) return

    const localReport = this._readLocalReport()
    this._localReport = localReport
    this.setData({
      ...localReport,
      statusMessage: '',
      loading: true
    })

    try {
      const response = await request({
        url: '/patient/comprehensive_report',
        method: 'GET'
      })
      const report = mergeReport(localReport, response)
      this.setData({
        ...report,
        statusMessage: '',
        loading: false
      }, () => this._scheduleDraw())
    } catch (error) {
      this.setData({
        ...localReport,
        statusMessage: '暂时无法同步，当前展示本地结果',
        loading: false
      }, () => this._scheduleDraw())
    }
  },

  _scheduleDraw() {
    wx.nextTick(() => this._drawCharts())
  },

  _drawCharts() {
    if (this.data.scale.hasRadar) {
      this._drawRadar()
    }
    if (this.data.tracking.hasTrend) {
      this._drawTrend()
    }
  },

  _drawRadar() {
    const geometry = createRadarGeometry(
      this.data.scale.radarAxes,
      330,
      280,
      88
    )
    if (!geometry) return

    const context = wx.createCanvasContext('reportRadarCanvas', this)
    context.setLineWidth(1)
    context.setStrokeStyle('#cbd8e2')
    for (const ring of geometry.gridPolygons) {
      drawPolygon(context, ring)
      context.stroke()
    }

    context.setStrokeStyle('#d6e1e9')
    for (const point of geometry.gridPolygons.at(-1)) {
      context.beginPath()
      context.moveTo(geometry.center.x, geometry.center.y)
      context.lineTo(point.x, point.y)
      context.stroke()
    }

    drawPolygon(context, geometry.dataPoints)
    context.setFillStyle('rgba(63, 124, 120, 0.24)')
    context.fill()
    context.setStrokeStyle('#3f7c78')
    context.setLineWidth(3)
    context.stroke()

    context.setFillStyle('#3f7c78')
    for (const point of geometry.dataPoints) {
      context.beginPath()
      context.arc(point.x, point.y, 4, 0, Math.PI * 2)
      context.fill()
    }

    context.setFillStyle('#17324d')
    context.setFontSize(12)
    context.setTextBaseline('middle')
    for (const point of geometry.labelPoints) {
      const difference = point.x - geometry.center.x
      context.setTextAlign(
        Math.abs(difference) < 8
          ? 'center'
          : difference > 0 ? 'left' : 'right'
      )
      context.fillText(point.label, point.x, point.y)
    }
    context.draw()
  },

  _drawTrend() {
    const points = createChartPoints(
      this.data.tracking.attentionValues,
      330,
      180,
      24,
      5,
      1
    )
    const context = wx.createCanvasContext('reportTrendCanvas', this)
    context.setStrokeStyle('#dce5ec')
    context.setLineWidth(1)
    context.beginPath()
    context.moveTo(24, 156)
    context.lineTo(306, 156)
    context.stroke()

    context.setStrokeStyle('#3f7c78')
    context.setLineWidth(3)
    context.beginPath()
    let drawing = false
    for (const point of points) {
      if (!point) {
        drawing = false
        continue
      }
      if (!drawing) {
        context.moveTo(point.x, point.y)
        drawing = true
      } else {
        context.lineTo(point.x, point.y)
      }
    }
    context.stroke()

    context.setFillStyle('#3f7c78')
    for (const point of points.filter(Boolean)) {
      context.beginPath()
      context.arc(point.x, point.y, 4, 0, Math.PI * 2)
      context.fill()
    }
    context.draw()
  },

  openTask(event) {
    const route = TASK_ROUTES[event.currentTarget.dataset.task]
    if (!route) return
    wx.navigateTo({ url: route })
  },

  openTrend() {
    wx.navigateTo({
      url: '/pages/tracking-trend/index'
    })
  },

  goBack() {
    wx.navigateBack({
      delta: 1
    })
  }
})
