const LATEST_RESULTS_KEY = 'cognitive_latest_results'
const TEST_DEFINITIONS = Object.freeze([
  {
    id: 'reaction',
    title: 'Go/No-Go',
    description: '反应速度与抑制控制',
    icon: '反',
    url: '/pages/cognitive/index'
  },
  {
    id: 'stroop',
    title: 'Stroop',
    description: '颜色选择与冲突抑制',
    icon: '色',
    url: '/pages/stroop/index'
  }
])

function isValidPayload(payload, expectedType) {
  return Boolean(
    payload &&
    payload.test_type === expectedType &&
    payload.result_json &&
    typeof payload.result_json === 'object' &&
    payload.result_json.raw_result &&
    typeof payload.result_json.raw_result === 'object' &&
    typeof payload.result_json.finished_at === 'string'
  )
}

function normalizeLatestResults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return TEST_DEFINITIONS.reduce((results, definition) => {
    const payload = value[definition.id]
    if (isValidPayload(payload, definition.id)) {
      results[definition.id] = payload
    }
    return results
  }, {})
}

function mergeLatestResult(current, payload) {
  const normalized = normalizeLatestResults(current)
  const definition = TEST_DEFINITIONS.find(
    (item) => item.id === (payload && payload.test_type)
  )

  if (!definition || !isValidPayload(payload, definition.id)) {
    return normalized
  }

  return {
    ...normalized,
    [definition.id]: payload
  }
}

function metricText(payload) {
  const accuracy = Number(
    payload.result_json.raw_result.accuracy
  )
  return Number.isFinite(accuracy)
    ? `正确率 ${Math.max(0, Math.min(100, Math.round(accuracy)))}%`
    : '已记录结果'
}

function buildCognitiveSummary(value) {
  const latestResults = normalizeLatestResults(value)
  const cards = TEST_DEFINITIONS.map((definition) => {
    const payload = latestResults[definition.id]
    const completed = Boolean(payload)

    return {
      ...definition,
      completed,
      statusLabel: completed ? '查看最近结果' : '开始测试',
      primaryMetric: completed ? metricText(payload) : '尚未完成',
      finishedAt: completed
        ? payload.result_json.finished_at
        : ''
    }
  })
  const completedCount = cards.filter((card) => card.completed).length
  const totalCount = cards.length
  const allCompleted = completedCount === totalCount
  let summaryText = '完成两项认知任务，补充客观注意与抑制表现。'

  if (allCompleted) {
    summaryText = '两项认知任务均已完成，可继续进入每日追踪。'
  } else if (completedCount > 0) {
    summaryText = '已完成 1/2 项，继续完成另一项认知任务。'
  }

  return {
    latestResults,
    cards,
    completedCount,
    totalCount,
    progressPercent: Math.round((completedCount / totalCount) * 100),
    allCompleted,
    summaryText
  }
}

module.exports = {
  LATEST_RESULTS_KEY,
  TEST_DEFINITIONS,
  mergeLatestResult,
  normalizeLatestResults,
  buildCognitiveSummary
}
