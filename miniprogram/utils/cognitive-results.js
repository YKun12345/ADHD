const LATEST_RESULTS_KEY = 'cognitive_latest_results'
const TEST_DEFINITIONS = Object.freeze([
  {
    id: 'reaction',
    title: 'Go/No-Go',
    description: '反应速度与抑制控制',
    icon: '反',
    iconName: 'gonogo',
    iconShape: 'pill',
    estimatedMinutes: 5,
    url: '/pages/cognitive/index'
  },
  {
    id: 'simple_reaction',
    title: '简单反应时',
    description: '基础反应速度与稳定性',
    icon: '速',
    iconName: 'speed',
    iconShape: 'target',
    estimatedMinutes: 4,
    url: '/pages/simple-reaction/index'
  },
  {
    id: 'stroop',
    title: 'Stroop',
    description: '颜色选择与冲突抑制',
    icon: '色',
    iconName: 'stroop',
    iconShape: 'lens',
    estimatedMinutes: 6,
    url: '/pages/stroop/index'
  },
  {
    id: 'trail',
    title: '连线测试',
    description: '视觉搜索与认知转换',
    icon: '线',
    iconName: 'trail',
    iconShape: 'path',
    estimatedMinutes: 5,
    url: '/pages/trail/index'
  },
  {
    id: 'flanker',
    title: 'Flanker',
    description: '目标聚焦与干扰抑制',
    icon: '向',
    iconName: 'flanker',
    iconShape: 'arrows',
    estimatedMinutes: 6,
    url: '/pages/flanker/index'
  },
  {
    id: 'nback',
    title: '2-back',
    description: '空间工作记忆更新',
    icon: '忆',
    iconName: 'nback',
    iconShape: 'grid',
    estimatedMinutes: 8,
    url: '/pages/nback/index'
  },
  {
    id: 'digit',
    title: '数字广度',
    description: '短时记忆与信息操作',
    icon: '数',
    iconName: 'digit',
    iconShape: 'digits',
    estimatedMinutes: 10,
    url: '/pages/digit-span/index'
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
  let summaryText = '完成七项认知任务，补充客观注意、抑制与工作记忆表现。'

  if (allCompleted) {
    summaryText = '七项认知任务均已完成，可继续进入每日追踪。'
  } else if (completedCount > 0) {
    summaryText = `已完成 ${completedCount}/7 项，可继续完成剩余认知任务。`
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
