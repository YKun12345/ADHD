const TOTAL_DAYS = 14

function average(values) {
  const present = values.filter((value) => Number.isFinite(value))
  return present.length
    ? Math.round(present.reduce((sum, value) => sum + value, 0) / present.length)
    : 0
}

function valuesFor(logs, field) {
  const values = Array(TOTAL_DAYS).fill(null)
  for (const log of Array.isArray(logs) ? logs : []) {
    if (!log || !Number.isInteger(log.day_index) || log.day_index < 1 || log.day_index > TOTAL_DAYS) continue
    const value = Number(log[field])
    if (Number.isFinite(value)) values[log.day_index - 1] = value
  }
  return values
}

function buildSeries(logs, field, label, unit, fixedMax) {
  const values = valuesFor(logs, field)
  const present = values.filter((value) => Number.isFinite(value))
  return {
    label,
    unit,
    values,
    average: average(values),
    maxValue: fixedMax || Math.max(1, ...present)
  }
}

function buildTrackingTrendModel(logs) {
  const valid = (Array.isArray(logs) ? logs : []).filter((log) => (
    log && Number.isInteger(log.day_index) && log.day_index >= 1 && log.day_index <= TOTAL_DAYS
  ))
  return {
    hasData: valid.length > 0,
    completedCount: new Set(valid.map((log) => log.day_index)).size,
    demoMode: valid.some((log) => log.demo === true),
    series: {
      mood: buildSeries(valid, 'mood_tag', '情绪评分', '分', 5),
      attention: buildSeries(valid, 'attention_rating', '注意力评分', '分', 5),
      focus: buildSeries(valid, 'focus_minutes', '专注时长', '分钟')
    }
  }
}

function createChartPoints(values, width, height, padding = 20, maxValue = 5, minValue = 1) {
  const plotWidth = width - padding * 2
  const plotHeight = height - padding * 2
  return values.map((value, index) => {
    if (!Number.isFinite(value)) return null
    return {
      day: index + 1,
      value,
      x: Math.round(padding + (plotWidth * index) / (TOTAL_DAYS - 1)),
      y: Math.round(
        padding + plotHeight * (1 - (value - minValue) / (maxValue - minValue || 1))
      )
    }
  })
}

module.exports = { buildTrackingTrendModel, createChartPoints }
