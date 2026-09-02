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
const {
  createCanvasMetrics,
  measureTextWidths,
  createCartesianCanvasLayout,
  createRadarCanvasLayout,
  clampRadarLabelX
} = require('../../utils/canvas-scale')

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

function readDevicePixelRatio() {
  try {
    if (typeof wx.getWindowInfo === 'function') {
      const windowInfo = wx.getWindowInfo()
      if (windowInfo && Number.isFinite(windowInfo.pixelRatio) && windowInfo.pixelRatio > 0) {
        return windowInfo.pixelRatio
      }
    }
  } catch (error) {}
  try {
    if (typeof wx.getSystemInfoSync === 'function') {
      const systemInfo = wx.getSystemInfoSync()
      if (systemInfo && Number.isFinite(systemInfo.pixelRatio) && systemInfo.pixelRatio > 0) {
        return systemInfo.pixelRatio
      }
    }
  } catch (error) {}
  return 1
}

function formatAxisValue(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function drawTrendGrid(context, metrics, layout, minValue, maxValue) {
  const midpoint = (minValue + maxValue) / 2
  const gridValues = [maxValue, midpoint, minValue]
  context.font = '11px sans-serif'
  context.textAlign = 'right'
  context.textBaseline = 'middle'
  context.lineWidth = 1
  context.strokeStyle = '#cbd9de'
  context.fillStyle = '#506b75'
  gridValues.forEach((value, index) => {
    const y = layout.top + ((layout.plotHeight / 2) * index)
    context.beginPath()
    context.moveTo(layout.left, y)
    context.lineTo(metrics.cssWidth - layout.right, y)
    context.stroke()
    context.fillText(formatAxisValue(value), layout.left - 7, y)
  })
}

registerPatientPage({
  data: {
    ...initialReport,
    loading: false,
    professionalExpanded: false,
    radarStatusMessage: '',
    trendStatusMessage: ''
  },

  onLoad() {
    this._canvasDisposed = false
    this._chartRenderToken = 0
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
    const lease = capturePatientSessionLease()

    try {
      const response = await request({
        url: '/patient/comprehensive_report',
        method: 'GET'
      })
      if (!isPatientSessionLeaseCurrent(lease)) return
      const report = mergeReport(localReport, response)
      this.setData({
        ...report,
        statusMessage: '',
        loading: false
      }, () => this._scheduleDraw())
    } catch (error) {
      if (
        isPatientSessionError(error) ||
        !isPatientSessionLeaseCurrent(lease)
      ) {
        return
      }
      this.setData({
        ...localReport,
        statusMessage: '暂时无法同步，当前展示本地结果',
        loading: false
      }, () => this._scheduleDraw())
    }
  },

  onPatientSessionEnded() {
    this._localReport = null
    this._chartRenderToken = (this._chartRenderToken || 0) + 1
  },

  onUnload() {
    this._canvasDisposed = true
    this._chartRenderToken += 1
  },

  _scheduleDraw() {
    if (this._canvasDisposed) return
    const lease = capturePatientSessionLease()
    const renderToken = this._chartRenderToken + 1
    this._chartRenderToken = renderToken
    wx.nextTick(() => {
      if (this._canvasDisposed) return
      if (renderToken !== this._chartRenderToken) return
      if (!isPatientSessionLeaseCurrent(lease)) return
      this._drawCharts()
    })
  },

  _drawCharts() {
    if (this._canvasDisposed) return
    const renderToken = this._chartRenderToken
    if (this.data.scale && this.data.scale.hasRadar) {
      this._drawRadar(renderToken)
    }
    if (this.data.tracking && this.data.tracking.hasTrend) {
      this._drawTrend(renderToken)
    }
  },

  _drawRadar(renderToken) {
    if (this._canvasDisposed) return
    if (typeof this.createSelectorQuery !== 'function') {
      this.setData({ radarStatusMessage: '当前环境暂不支持雷达图绘制' })
      return
    }
    this.createSelectorQuery()
      .select('#reportRadarCanvas')
      .fields({ node: true, size: true })
      .exec((results) => {
        if (this._canvasDisposed) return
        if (renderToken !== this._chartRenderToken) return
        const canvasResult = results && results[0]
        if (!canvasResult || !canvasResult.node || !canvasResult.width || !canvasResult.height) {
          this.setData({ radarStatusMessage: '暂时无法加载雷达图，请稍后重试' })
          return
        }
        const canvas = canvasResult.node
        const metrics = createCanvasMetrics(
          canvasResult.width,
          canvasResult.height,
          readDevicePixelRatio()
        )
        canvas.width = metrics.pixelWidth
        canvas.height = metrics.pixelHeight
        const context = canvas.getContext('2d')
        if (!context) {
          this.setData({ radarStatusMessage: '当前环境暂不支持雷达图绘制' })
          return
        }
        if (this.data.radarStatusMessage) this.setData({ radarStatusMessage: '' })
        context.scale(metrics.dpr, metrics.dpr)

        if (!this.data.scale || !this.data.scale.hasRadar) return

        context.font = '12px sans-serif'
        const labelWidths = measureTextWidths(
          this.data.scale.radarAxes.map((axis) => axis.label),
          typeof context.measureText === 'function'
            ? (text) => context.measureText(text)
            : undefined
        )
        const radarLayout = createRadarCanvasLayout(
          metrics.cssWidth,
          metrics.cssHeight,
          labelWidths
        )

        const geometry = createRadarGeometry(
          this.data.scale.radarAxes,
          metrics.cssWidth,
          metrics.cssHeight,
          radarLayout.radius
        )
        if (!geometry) return
        context.clearRect(0, 0, metrics.cssWidth, metrics.cssHeight)
        context.lineWidth = 1
        context.strokeStyle = '#b6c8d0'
        for (const ring of geometry.gridPolygons) {
          drawPolygon(context, ring)
          context.stroke()
        }

        context.strokeStyle = '#c8d6dc'
        const outerPolygon = geometry.gridPolygons[geometry.gridPolygons.length - 1]
        for (const point of outerPolygon) {
          context.beginPath()
          context.moveTo(geometry.center.x, geometry.center.y)
          context.lineTo(point.x, point.y)
          context.stroke()
        }

        drawPolygon(context, geometry.dataPoints)
        context.fillStyle = 'rgba(35, 107, 128, 0.18)'
        context.fill()
        context.strokeStyle = '#236b80'
        context.lineWidth = 2.5
        context.stroke()

        context.fillStyle = '#236b80'
        for (const point of geometry.dataPoints) {
          context.beginPath()
          context.arc(point.x, point.y, 3.5, 0, Math.PI * 2)
          context.fill()
        }

        context.fillStyle = '#294d59'
        context.font = '12px sans-serif'
        context.textBaseline = 'middle'
        geometry.labelPoints.forEach((point, index) => {
          const difference = point.x - geometry.center.x
          const alignment = Math.abs(difference) < 8
            ? 'center'
            : difference > 0 ? 'left' : 'right'
          context.textAlign = alignment
          const safeX = clampRadarLabelX(
            point.x,
            labelWidths[index],
            alignment,
            metrics.cssWidth,
            radarLayout.safeInset
          )
          const safeY = Math.min(
            metrics.cssHeight - radarLayout.safeInset - 7,
            Math.max(radarLayout.safeInset + 7, point.y)
          )
          context.fillText(point.label, safeX, safeY)
        })
      })
  },

  _drawTrend(renderToken) {
    if (this._canvasDisposed) return
    if (typeof this.createSelectorQuery !== 'function') {
      this.setData({ trendStatusMessage: '当前环境暂不支持趋势图绘制' })
      return
    }
    this.createSelectorQuery()
      .select('#reportTrendCanvas')
      .fields({ node: true, size: true })
      .exec((results) => {
        if (this._canvasDisposed) return
        if (renderToken !== this._chartRenderToken) return
        const canvasResult = results && results[0]
        if (!canvasResult || !canvasResult.node || !canvasResult.width || !canvasResult.height) {
          this.setData({ trendStatusMessage: '暂时无法加载趋势图，请稍后重试' })
          return
        }
        const canvas = canvasResult.node
        const metrics = createCanvasMetrics(
          canvasResult.width,
          canvasResult.height,
          readDevicePixelRatio()
        )
        canvas.width = metrics.pixelWidth
        canvas.height = metrics.pixelHeight
        const context = canvas.getContext('2d')
        if (!context) {
          this.setData({ trendStatusMessage: '当前环境暂不支持趋势图绘制' })
          return
        }
        if (this.data.trendStatusMessage) this.setData({ trendStatusMessage: '' })
        context.scale(metrics.dpr, metrics.dpr)
        context.clearRect(0, 0, metrics.cssWidth, metrics.cssHeight)

        if (!this.data.tracking || !this.data.tracking.hasTrend) return

        const gridValues = [5, 3, 1]
        context.font = '11px sans-serif'
        const labelWidths = measureTextWidths(
          gridValues.map(formatAxisValue),
          typeof context.measureText === 'function'
            ? (text) => context.measureText(text)
            : undefined
        )
        const layout = createCartesianCanvasLayout(
          metrics.cssWidth,
          metrics.cssHeight,
          labelWidths
        )
        const points = createChartPoints(
          this.data.tracking.attentionValues,
          layout.plotWidth,
          layout.plotHeight,
          0,
          5,
          1
        ).map((point) => point && ({
          ...point,
          x: point.x + layout.left,
          y: point.y + layout.top
        }))
        drawTrendGrid(context, metrics, layout, 1, 5)

        context.strokeStyle = '#236b80'
        context.lineWidth = 2.5
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

        context.fillStyle = '#236b80'
        for (const point of points.filter(Boolean)) {
          context.beginPath()
          context.arc(point.x, point.y, 3.5, 0, Math.PI * 2)
          context.fill()
        }
      })
  },

  openTask(event) {
    const route = TASK_ROUTES[event.currentTarget.dataset.task]
    if (!route) return
    wx.navigateTo({ url: route })
  },

  toggleProfessional() {
    this.setData({ professionalExpanded: !this.data.professionalExpanded })
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
