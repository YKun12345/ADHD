const { registerPatientPage } = require('../../utils/patient-page')
const { TRACKING_LOGS_KEY } = require('../../utils/tracking-data')
const { buildTrackingTrendModel, createChartPoints, createDayAxisTicks } = require('../../utils/tracking-trend')
const {
  createCanvasMetrics,
  measureTextWidths,
  createCartesianCanvasLayout
} = require('../../utils/canvas-scale')
const {
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
} = require('../../utils/session-privacy')

const METRIC_TABS = [
  { key: 'mood', label: '情绪', color: '#a6424a' },
  { key: 'attention', label: '注意力', color: '#236b80' },
  { key: 'focus', label: '专注时长', color: '#315f9c' }
]

function readDevicePixelRatio() {
  try {
    if (typeof wx.getWindowInfo === 'function') {
      const windowInfo = wx.getWindowInfo()
      if (windowInfo && Number.isFinite(windowInfo.pixelRatio) && windowInfo.pixelRatio > 0) return windowInfo.pixelRatio
    }
  } catch (error) {}
  try {
    if (typeof wx.getSystemInfoSync === 'function') {
      const systemInfo = wx.getSystemInfoSync()
      if (systemInfo && Number.isFinite(systemInfo.pixelRatio) && systemInfo.pixelRatio > 0) return systemInfo.pixelRatio
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
  context.strokeStyle = '#cbd9de'
  context.fillStyle = '#506b75'
  context.lineWidth = 1
  gridValues.forEach((value, index) => {
    const y = layout.top + ((layout.plotHeight / 2) * index)
    context.beginPath()
    context.moveTo(layout.left, y)
    context.lineTo(metrics.cssWidth - layout.right, y)
    context.stroke()
    context.fillText(formatAxisValue(value), layout.left - 7, y)
  })
  context.textBaseline = 'middle'
  createDayAxisTicks(layout).forEach((tick, index) => {
    context.textAlign = index === 0 ? 'left' : index === 2 ? 'right' : 'center'
    context.fillText(tick.label, tick.x, metrics.cssHeight - 8)
  })
}

registerPatientPage({
  data: {
    metricTabs: METRIC_TABS,
    activeMetric: 'mood',
    hasData: false,
    completedCount: 0,
    demoMode: false,
    averageValue: 0,
    metricLabel: '情绪评分',
    metricUnit: '分',
    rangeMinimum: 1,
    rangeMidpoint: 3,
    rangeMaximum: 5,
    chartStatusMessage: '',
    chartCanvasWidth: 0,
    chartCanvasHeight: 0
  },
  onShow() {
    this._canvasDisposed = false
    this._model = buildTrackingTrendModel(wx.getStorageSync(TRACKING_LOGS_KEY))
    this._applyMetric(this.data.activeMetric || 'mood')
  },
  onReady() { this._scheduleRedraw(this.data.activeMetric) },
  onResize() { this._scheduleRedraw(this.data.activeMetric) },
  onPageScroll() { this._scheduleRedraw(this.data.activeMetric) },
  selectMetric(event) {
    const metric = event.currentTarget.dataset.metric
    if (!METRIC_TABS.some((item) => item.key === metric)) return
    this._applyMetric(metric)
  },
  _applyMetric(metric) {
    if (this._canvasDisposed || !this._model) return
    this._chartRenderToken = (this._chartRenderToken || 0) + 1
    const series = this._model.series[metric]
    const rangeMinimum = metric === 'focus' ? 0 : 1
    const rangeMaximum = series.maxValue
    const rangeMidpoint = (rangeMinimum + rangeMaximum) / 2
    this.setData({
      activeMetric: metric,
      hasData: this._model.hasData,
      completedCount: this._model.completedCount,
      demoMode: this._model.demoMode,
      averageValue: series.average,
      metricLabel: series.label,
      metricUnit: series.unit,
      rangeMinimum,
      rangeMidpoint: formatAxisValue(rangeMidpoint),
      rangeMaximum,
      chartStatusMessage: ''
    }, () => this._scheduleRedraw(metric))
  },
  _scheduleRedraw(metric) {
    if (this._canvasDisposed || !this._model || this.data.activeMetric !== metric) return
    const lease = capturePatientSessionLease()
    const renderToken = (this._chartRenderToken || 0) + 1
    this._chartRenderToken = renderToken
    wx.nextTick(() => {
      if (!this._canDraw(renderToken, metric, lease)) return
      this._drawChart(metric)
    })
  },
  _canDraw(renderToken, metric, lease) {
    return !this._canvasDisposed && this._model &&
      renderToken === this._chartRenderToken &&
      this.data.activeMetric === metric && isPatientSessionLeaseCurrent(lease)
  },
  _drawChart(metric) {
    if (this._canvasDisposed) return
    if (!this._model || !this._model.hasData) return
    const series = this._model.series[metric]
    const tab = METRIC_TABS.find((item) => item.key === metric)
    const minValue = metric === 'focus' ? 0 : 1
    const renderToken = (this._chartRenderToken || 0) + 1
    this._chartRenderToken = renderToken
    const lease = capturePatientSessionLease()
    if (typeof this.createSelectorQuery !== 'function') {
      this.setData({ chartStatusMessage: '当前环境暂不支持趋势图绘制' })
      return
    }
    this.createSelectorQuery()
      .select('#trackingTrendPlot')
      .boundingClientRect()
      .select('#trackingTrendCanvas')
      .fields({ node: true, size: true })
      .exec((results) => {
        if (this._canvasDisposed) return
        if (renderToken !== this._chartRenderToken) return
        if (this.data.activeMetric !== metric) return
        if (!isPatientSessionLeaseCurrent(lease)) return
        const plotBounds = results && results[0]
        const canvasResult = results && results[1]
        if (!plotBounds || !plotBounds.width || !plotBounds.height || !canvasResult || !canvasResult.node) {
          this.setData({ chartStatusMessage: '暂时无法加载趋势图，请稍后重试' })
          return
        }
        const canvas = canvasResult.node
        // The wrapper owns layout; intrinsic physical canvas dimensions must not affect its CSS size.
        const metrics = createCanvasMetrics(plotBounds.width, plotBounds.height, readDevicePixelRatio())
        this.setData({ chartCanvasWidth: metrics.cssWidth, chartCanvasHeight: metrics.cssHeight }, () => wx.nextTick(() => {
          if (!this._canDraw(renderToken, metric, lease)) return
          canvas.width = metrics.pixelWidth
          canvas.height = metrics.pixelHeight
          const context = canvas.getContext('2d')
          if (!context) {
            this.setData({ chartStatusMessage: '当前环境暂不支持趋势图绘制' })
            return
          }
          if (this.data.chartStatusMessage) this.setData({ chartStatusMessage: '' })
          if (typeof context.setTransform === 'function') context.setTransform(1, 0, 0, 1, 0, 0)
          context.clearRect(0, 0, metrics.pixelWidth, metrics.pixelHeight)
          if (typeof context.setTransform === 'function') {
            context.setTransform(metrics.pixelWidth / metrics.cssWidth, 0, 0, metrics.pixelHeight / metrics.cssHeight, 0, 0)
          } else {
            // Assigning canvas.width/height above resets the transform on older 2D implementations.
            context.scale(metrics.dpr, metrics.dpr)
          }

          const gridValues = [
            series.maxValue,
            (minValue + series.maxValue) / 2,
            minValue
          ]
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
            series.values,
            layout.plotWidth,
            layout.plotHeight,
            0,
            series.maxValue,
            minValue
          ).map((point) => point && ({
            ...point,
            x: point.x + layout.left,
            y: point.y + layout.top
        }))
        drawTrendGrid(context, metrics, layout, minValue, series.maxValue)
        context.save()
        context.beginPath()
        context.rect(layout.left - 4, layout.top - 4, layout.plotWidth + 8, layout.plotHeight + 8)
        context.clip()
        context.strokeStyle = tab.color
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
        context.fillStyle = tab.color
        for (const point of points.filter(Boolean)) {
          context.beginPath()
          context.arc(point.x, point.y, 3.5, 0, Math.PI * 2)
          context.fill()
        }
        context.restore()
        }))
      })
  },
  onPatientSessionEnded() {
    this._canvasDisposed = true
    this._model = null
    this._chartRenderToken = (this._chartRenderToken || 0) + 1
  },
  onHide() {
    this._canvasDisposed = true
    this._chartRenderToken = (this._chartRenderToken || 0) + 1
  },
  onUnload() {
    this._canvasDisposed = true
    this._chartRenderToken = (this._chartRenderToken || 0) + 1
  },
  goBack() { wx.navigateBack({ delta: 1 }) }
})
