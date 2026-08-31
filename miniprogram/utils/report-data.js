const { buildTrackingTrendModel } = require('./tracking-trend')

const SCALE_LATEST_RESULT_KEY = 'scale_latest_result'
const RADAR_MAX = 20
const RADAR_SCHEMAS = Object.freeze({
  ASRS: [
    ['attention_control', '注意控制'],
    ['organization', '组织管理'],
    ['task_activation', '任务启动'],
    ['hyperactivity', '多动表现'],
    ['impulsivity', '冲动控制']
  ],
  SNAP_IV: [
    ['attention_control', '注意控制'],
    ['organization', '组织管理'],
    ['hyperactivity', '多动表现'],
    ['impulsivity', '冲动控制'],
    ['emotional_regulation', '情绪调节']
  ]
})
const COGNITIVE_DEFINITIONS = Object.freeze([
  { id: 'reaction', title: 'Go/No-Go', metric: 'accuracy' },
  { id: 'simple_reaction', title: '简单反应时', metric: 'simpleReaction' },
  { id: 'stroop', title: 'Stroop', metric: 'stroop' },
  { id: 'trail', title: '连线测试', metric: 'trail' },
  { id: 'flanker', title: 'Flanker', metric: 'accuracy' },
  { id: 'nback', title: '2-back', metric: 'nback' },
  { id: 'digit', title: '数字广度', metric: 'digit' }
])
const RISK_LABELS = Object.freeze({
  low: '低风险',
  medium: '中等风险',
  high: '高风险'
})
const RESPONDENT_LABELS = Object.freeze({
  self: '本人填写',
  parent: '家长填写',
  guardian: '监护人填写',
  teacher: '教师填写'
})
const PROFESSIONAL_DATA_MESSAGE = '影像与模型结果尚未接入患者端'

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback
}

function normalizePatientType(value) {
  const normalized = cleanText(value).toLowerCase()
  return normalized === 'adult' || normalized === 'child'
    ? normalized
    : ''
}

function patientTypeLabel(patientType) {
  if (patientType === 'adult') return '成人患者'
  if (patientType === 'child') return '儿童患者'
  return '患者'
}

function emptyScale() {
  return {
    hasData: false,
    source: '',
    scaleType: '',
    scaleTypeLabel: '',
    respondentType: '',
    respondentLabel: '',
    totalScore: null,
    riskLevel: '',
    riskLabel: '',
    summary: '',
    recommendations: [],
    createdAt: '',
    hasRadar: false,
    radarAxes: []
  }
}

function normalizeRadar(scaleType, radarScores) {
  const schema = RADAR_SCHEMAS[scaleType]
  if (!schema || !isObject(radarScores)) {
    return []
  }

  const axes = []
  for (const [key, label] of schema) {
    const value = finiteNumber(radarScores[key])
    if (value === null) {
      return []
    }
    axes.push({
      key,
      label,
      value: clamp(value, 0, RADAR_MAX),
      maxValue: RADAR_MAX
    })
  }
  return axes
}

function normalizeScaleResult(value, source = 'local') {
  if (!isObject(value)) return emptyScale()

  const scaleType = cleanText(value.scale_type)
  const respondentType = cleanText(value.respondent_type)
  const totalScore = finiteNumber(value.total_score)
  const riskLevel = cleanText(value.risk_level)
  const summaryIsString = typeof value.summary === 'string'
  const recommendationsAreValid = Array.isArray(value.recommendations)
  const schema = RADAR_SCHEMAS[scaleType]

  if (
    !schema ||
    totalScore === null ||
    !Object.prototype.hasOwnProperty.call(RISK_LABELS, riskLevel) ||
    !summaryIsString ||
    !recommendationsAreValid
  ) {
    return emptyScale()
  }

  const radarAxes = normalizeRadar(scaleType, value.radar_scores)
  return {
    hasData: true,
    source,
    scaleType,
    scaleTypeLabel: scaleType === 'ASRS' ? 'ASRS 成人自评量表' : 'SNAP-IV 儿童量表',
    respondentType,
    respondentLabel: RESPONDENT_LABELS[respondentType] || '填写方式未标注',
    totalScore,
    riskLevel,
    riskLabel: RISK_LABELS[riskLevel],
    summary: value.summary.trim(),
    recommendations: value.recommendations
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim()),
    createdAt: cleanText(value.created_at),
    hasRadar: radarAxes.length === 5,
    radarAxes
  }
}

function isReportableScaleResult(value) {
  const scale = normalizeScaleResult(value)
  return Boolean(
    scale.hasData &&
    scale.respondentType &&
    scale.hasRadar
  )
}

function emptyCognitive() {
  return {
    hasData: false,
    source: '',
    completedCount: 0,
    totalCount: COGNITIVE_DEFINITIONS.length,
    summary: '尚未完成认知测试',
    cards: []
  }
}

function percentMetric(value, fallback = '已记录结果') {
  const number = finiteNumber(value)
  return number === null ? fallback : `正确率 ${Math.round(clamp(number, 0, 100))}%`
}

function cognitiveMetrics(definition, rawResult) {
  if (definition.metric === 'simpleReaction') {
    const median = finiteNumber(rawResult.median_reaction_time_ms)
    return {
      primaryMetric: median === null ? '已记录结果' : `中位反应时 ${Math.round(median)} ms`,
      secondaryMetric: percentMetric(rawResult.accuracy, '暂无有效率')
    }
  }
  if (definition.metric === 'trail') {
    const elapsed = finiteNumber(rawResult.elapsed_ms)
    const errors = finiteNumber(rawResult.errors)
    return {
      primaryMetric: elapsed === null ? '已记录结果' : `总用时 ${(elapsed / 1000).toFixed(1)} 秒`,
      secondaryMetric: errors === null ? '暂无错误记录' : `错误 ${Math.round(errors)} 次`
    }
  }
  if (definition.metric === 'stroop') {
    const median = finiteNumber(rawResult.median_reaction_time_ms)
    const interference = finiteNumber(rawResult.interference_effect_ms)
    const average = finiteNumber(rawResult.average_reaction_time_ms)
    return {
      primaryMetric: median === null ? percentMetric(rawResult.accuracy) : `中位反应时 ${Math.round(median)} ms`,
      secondaryMetric: interference === null
        ? (average === null ? percentMetric(rawResult.accuracy) : `平均反应时 ${Math.round(average)} ms`)
        : `干扰效应 ${Math.round(interference)} ms`
    }
  }
  if (definition.metric === 'nback') {
    const dPrime = finiteNumber(rawResult.d_prime)
    return {
      primaryMetric: percentMetric(rawResult.accuracy),
      secondaryMetric: dPrime === null ? '暂无辨别指数' : `辨别指数 ${dPrime}`
    }
  }
  if (definition.metric === 'digit') {
    const forward = finiteNumber(rawResult.forward_max_span)
    const backward = finiteNumber(rawResult.backward_max_span)
    return {
      primaryMetric: forward === null || backward === null
        ? '已记录结果'
        : `顺背 ${Math.round(forward)} · 倒背 ${Math.round(backward)}`,
      secondaryMetric: percentMetric(rawResult.accuracy)
    }
  }
  const reactionTime = finiteNumber(rawResult.average_reaction_time_ms)
  return {
    primaryMetric: percentMetric(rawResult.accuracy),
    secondaryMetric: reactionTime !== null && reactionTime >= 0
      ? `平均反应时 ${Math.round(reactionTime)} ms`
      : '暂无反应时'
  }
}

function normalizeLocalCognitive(value) {
  if (!isObject(value)) return emptyCognitive()

  const cards = []
  for (const definition of COGNITIVE_DEFINITIONS) {
    const payload = value[definition.id]
    const resultJson = isObject(payload) && payload.test_type === definition.id
      ? payload.result_json
      : null
    const rawResult = isObject(resultJson) ? resultJson.raw_result : null
    if (!isObject(rawResult)) continue
    const metrics = cognitiveMetrics(definition, rawResult)
    const quality = isObject(resultJson.quality) ? resultJson.quality : null
    cards.push({
      id: definition.id,
      title: definition.title,
      ...metrics,
      qualityLabel: quality && quality.valid === false ? '数据质量需关注' : '数据质量正常',
      finishedAt: cleanText(resultJson.finished_at)
    })
  }

  if (!cards.length) return emptyCognitive()
  return {
    hasData: true,
    source: 'local',
    completedCount: cards.length,
    totalCount: COGNITIVE_DEFINITIONS.length,
    summary: cards.length === COGNITIVE_DEFINITIONS.length
      ? '七项认知任务均已完成。'
      : `已完成 ${cards.length}/7 项认知任务，可继续补充测试。`,
    cards
  }
}

function normalizeServerCognitive(value) {
  if (!isObject(value) || !Array.isArray(value.latest_tests)) {
    return emptyCognitive()
  }

  const cards = []
  for (const definition of COGNITIVE_DEFINITIONS) {
    const item = value.latest_tests.find((candidate) => (
      isObject(candidate) && candidate.test_type === definition.id
    ))
    if (!item || !cleanText(item.key_metric)) continue

    cards.push({
      id: definition.id,
      title: cleanText(item.test_name, definition.title),
      primaryMetric: cleanText(item.key_metric),
      secondaryMetric: cleanText(item.status_text, '已记录'),
      qualityLabel: '服务器已记录',
      finishedAt: cleanText(item.finished_at)
    })
  }

  if (!cards.length) return emptyCognitive()
  return {
    hasData: true,
    source: 'server',
    completedCount: cards.length,
    totalCount: COGNITIVE_DEFINITIONS.length,
    summary: cleanText(value.summary, '已生成认知测试摘要。'),
    cards
  }
}

function mergeCognitive(localCognitive, serverCognitive) {
  const local = isObject(localCognitive) ? localCognitive : emptyCognitive()
  const server = isObject(serverCognitive) ? serverCognitive : emptyCognitive()
  if (!local.hasData) return server
  if (!server.hasData) return local
  const localById = new Map(local.cards.map((card) => [card.id, card]))
  const serverById = new Map(server.cards.map((card) => [card.id, card]))
  const cards = COGNITIVE_DEFINITIONS
    .map((definition) => serverById.get(definition.id) || localById.get(definition.id))
    .filter(Boolean)
  return {
    hasData: cards.length > 0,
    source: 'mixed',
    completedCount: cards.length,
    totalCount: COGNITIVE_DEFINITIONS.length,
    summary: server.summary || (cards.length === COGNITIVE_DEFINITIONS.length
      ? '七项认知任务均已完成。'
      : `已完成 ${cards.length}/7 项认知任务。`),
    cards
  }
}

function emptyTracking() {
  return {
    hasData: false,
    source: '',
    sourceLabel: '',
    completedCount: 0,
    totalDays: 14,
    currentDay: 1,
    averageMood: null,
    averageAttention: null,
    averageFocusMinutes: null,
    demoMode: false,
    hasTrend: false,
    attentionValues: Array(14).fill(null)
  }
}

function normalizeLocalTracking(logs) {
  const model = buildTrackingTrendModel(logs)
  if (!model.hasData) return emptyTracking()

  const validLogs = (Array.isArray(logs) ? logs : []).filter((log) => (
    isObject(log) &&
    Number.isInteger(log.day_index) &&
    log.day_index >= 1 &&
    log.day_index <= 14
  ))
  const completedDays = Array.from(new Set(
    validLogs.map((log) => log.day_index)
  )).sort((left, right) => left - right)

  return {
    hasData: true,
    source: 'local',
    sourceLabel: model.demoMode ? '本地演示' : '本地记录',
    completedCount: model.completedCount,
    totalDays: 14,
    currentDay: completedDays.length
      ? Math.min(14, completedDays[completedDays.length - 1] + 1)
      : 1,
    averageMood: model.series.mood.average,
    averageAttention: model.series.attention.average,
    averageFocusMinutes: model.series.focus.average,
    demoMode: model.demoMode,
    hasTrend: model.series.attention.values.some(Number.isFinite),
    attentionValues: model.series.attention.values
  }
}

function normalizeServerTracking(value) {
  if (!isObject(value)) return emptyTracking()

  const completedDays = Array.isArray(value.completed_days)
    ? Array.from(new Set(value.completed_days.filter((day) => (
      Number.isInteger(day) && day >= 1 && day <= 14
    )))).sort((left, right) => left - right)
    : []
  const providedCount = finiteNumber(value.completed_count)
  const completedCount = Math.round(clamp(
    providedCount === null ? completedDays.length : providedCount,
    0,
    14
  ))
  if (!completedCount) return emptyTracking()

  const currentDayValue = finiteNumber(value.current_day)
  return {
    hasData: true,
    source: 'server',
    sourceLabel: '已同步',
    completedCount,
    totalDays: 14,
    currentDay: currentDayValue === null
      ? Math.min(14, completedCount + 1)
      : Math.round(clamp(currentDayValue, 1, 14)),
    averageMood: finiteNumber(value.average_mood),
    averageAttention: null,
    averageFocusMinutes: finiteNumber(value.average_focus_minutes),
    demoMode: false,
    hasTrend: false,
    attentionValues: Array(14).fill(null)
  }
}

function buildCoverage(scale, cognitive, tracking) {
  const completedCount = [
    scale.hasData,
    cognitive.hasData,
    tracking.hasData
  ].filter(Boolean).length

  return {
    completedCount,
    totalCount: 3,
    percent: Math.round((completedCount / 3) * 100)
  }
}

function assembleReport({
  patientName,
  patientType,
  source,
  sourceLabel,
  statusMessage = '',
  scale,
  cognitive,
  tracking
}) {
  const coverage = buildCoverage(scale, cognitive, tracking)
  return {
    patientName: cleanText(patientName, '患者'),
    patientType,
    patientTypeLabel: patientTypeLabel(patientType),
    source,
    sourceLabel,
    statusMessage,
    hasAnyData: coverage.completedCount > 0,
    scale,
    cognitive,
    tracking,
    coverage,
    professionalData: PROFESSIONAL_DATA_MESSAGE
  }
}

function buildLocalReport({
  user,
  scaleResult,
  cognitiveResults,
  trackingLogs
} = {}) {
  const safeUser = isObject(user) ? user : {}
  const profile = isObject(safeUser.patient_profile)
    ? safeUser.patient_profile
    : {}
  const patientType = normalizePatientType(profile.patient_type)

  return assembleReport({
    patientName: cleanText(safeUser.full_name, '患者'),
    patientType,
    source: 'local',
    sourceLabel: '本地结果',
    scale: normalizeScaleResult(scaleResult, 'local'),
    cognitive: normalizeLocalCognitive(cognitiveResults),
    tracking: normalizeLocalTracking(trackingLogs)
  })
}

function mergeReport(localReport, serverPayload) {
  const local = isObject(localReport)
    ? localReport
    : buildLocalReport()
  const server = isObject(serverPayload) ? serverPayload : {}
  const serverScale = isReportableScaleResult(server.latest_scale)
    ? normalizeScaleResult(server.latest_scale, 'server')
    : emptyScale()
  const serverCognitive = normalizeServerCognitive(server.cognitive_profile)
  const serverTracking = normalizeServerTracking(server.tracking_summary)

  const useServerScale = serverScale.hasData
  const cognitive = mergeCognitive(local.cognitive, serverCognitive)
  const useServerCognitive = serverCognitive.hasData
  const useServerTracking = !local.tracking.hasData && serverTracking.hasData
  const serverUsed = useServerScale || useServerCognitive || useServerTracking
  const localPatientType = normalizePatientType(local.patientType)
  const serverPatientType = normalizePatientType(server.patient_type)
  const localPatientName = cleanText(local.patientName)

  return assembleReport({
    patientName: localPatientName && localPatientName !== '患者'
      ? localPatientName
      : cleanText(server.patient_name, '患者'),
    patientType: localPatientType || serverPatientType,
    source: serverUsed ? 'server' : 'local',
    sourceLabel: serverUsed ? '已同步' : '本地结果',
    scale: useServerScale ? serverScale : local.scale,
    cognitive,
    tracking: useServerTracking ? serverTracking : local.tracking
  })
}

function rounded(value) {
  return Number(value.toFixed(2))
}

function polarPoint(centerX, centerY, radius, index, count = 5) {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count
  return {
    x: rounded(centerX + Math.cos(angle) * radius),
    y: rounded(centerY + Math.sin(angle) * radius)
  }
}

function createRadarGeometry(axes, width, height, radius) {
  if (
    !Array.isArray(axes) ||
    axes.length !== 5 ||
    !finiteNumber(width) ||
    !finiteNumber(height) ||
    !finiteNumber(radius) ||
    width <= 0 ||
    height <= 0 ||
    radius <= 0 ||
    !axes.every((axis) => (
      isObject(axis) &&
      finiteNumber(axis.value) !== null &&
      finiteNumber(axis.maxValue) !== null &&
      axis.maxValue > 0
    ))
  ) {
    return null
  }

  const center = {
    x: width / 2,
    y: height / 2
  }
  const gridPolygons = Array.from({ length: 5 }, (_, level) => (
    axes.map((_, index) => polarPoint(
      center.x,
      center.y,
      radius * ((level + 1) / 5),
      index
    ))
  ))
  const dataPoints = axes.map((axis, index) => polarPoint(
    center.x,
    center.y,
    radius * clamp(axis.value / axis.maxValue, 0, 1),
    index
  ))
  const labelPoints = axes.map((axis, index) => ({
    ...polarPoint(center.x, center.y, radius + 24, index),
    label: axis.label
  }))

  return {
    center,
    gridPolygons,
    dataPoints,
    labelPoints
  }
}

module.exports = {
  SCALE_LATEST_RESULT_KEY,
  isReportableScaleResult,
  buildLocalReport,
  mergeReport,
  createRadarGeometry
}
