const COLORS = Object.freeze([
  { key: 'red', label: '红', hex: '#c85c52' },
  { key: 'green', label: '绿', hex: '#3f8b7f' },
  { key: 'blue', label: '蓝', hex: '#3976b8' },
  { key: 'yellow', label: '黄', hex: '#d59b2d' }
])

const STROOP_TRIALS = Object.freeze([
  { wordKey: 'red', colorKey: 'red' },
  { wordKey: 'green', colorKey: 'blue' },
  { wordKey: 'blue', colorKey: 'blue' },
  { wordKey: 'yellow', colorKey: 'red' },
  { wordKey: 'red', colorKey: 'green' },
  { wordKey: 'green', colorKey: 'yellow' },
  { wordKey: 'yellow', colorKey: 'yellow' },
  { wordKey: 'blue', colorKey: 'green' }
])

const COLOR_KEYS = COLORS.map((color) => color.key)

function shuffled(values, random) {
  const result = values.slice()
  for (let index = result.length - 1; index > 0; index -= 1) {
    const sample = Number(random())
    const target = Math.min(index, Math.max(0, Math.floor((Number.isFinite(sample) ? sample : 0) * (index + 1))))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

function buildStroopTrials(count, congruentRatio = 0.75, random = Math.random) {
  const size = Math.max(0, Math.floor(count / COLOR_KEYS.length) * COLOR_KEYS.length)
  const congruentCount = Math.max(0, Math.min(size, Math.round(size * congruentRatio)))
  const trials = Array.from({ length: size }, (_, index) => {
    const colorKey = COLOR_KEYS[index % COLOR_KEYS.length]
    const congruent = index < congruentCount
    const offset = 1 + (Math.floor(index / COLOR_KEYS.length) % (COLOR_KEYS.length - 1))
    return {
      wordKey: congruent ? colorKey : COLOR_KEYS[(index + offset) % COLOR_KEYS.length],
      colorKey
    }
  })
  return shuffled(trials, random)
}

function normalizeReactionTime(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return 0
  }
  return Math.max(0, Math.round(number))
}

function isValidTrial(trial) {
  return Boolean(
    trial &&
    COLOR_KEYS.includes(trial.wordKey) &&
    COLOR_KEYS.includes(trial.colorKey)
  )
}

function evaluateStroopChoice(trial, selectedKey, reactionTimeMs) {
  if (!isValidTrial(trial)) {
    return null
  }

  if (selectedKey === null || selectedKey === '') {
    return {
      wordKey: trial.wordKey,
      colorKey: trial.colorKey,
      selectedKey: '',
      congruent: trial.wordKey === trial.colorKey,
      correct: false,
      outcome: 'omission',
      reactionTimeMs: null
    }
  }

  if (!COLOR_KEYS.includes(selectedKey)) return null

  return {
    wordKey: trial.wordKey,
    colorKey: trial.colorKey,
    selectedKey,
    congruent: trial.wordKey === trial.colorKey,
    correct: selectedKey === trial.colorKey,
    reactionTimeMs: normalizeReactionTime(reactionTimeMs)
  }
}

function percentage(value, total) {
  return total ? Math.round((value / total) * 100) : 0
}

function median(values) {
  if (!values.length) return 0
  const sorted = values.slice().sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return Math.round(sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2)
}

function summarizeStroopTrials(records = []) {
  const validRecords = Array.isArray(records)
    ? records.filter((record) => (
        record &&
        COLOR_KEYS.includes(record.wordKey) &&
        COLOR_KEYS.includes(record.colorKey) &&
        (COLOR_KEYS.includes(record.selectedKey) || record.outcome === 'omission') &&
        typeof record.correct === 'boolean'
      ))
    : []
  const correctRecords = validRecords.filter((record) => record.correct)
  const omissions = validRecords.filter((record) => record.outcome === 'omission').length
  const congruentRecords = validRecords.filter((record) => record.congruent)
  const incongruentRecords = validRecords.filter((record) => !record.congruent)
  const reactionTimes = validRecords
    .filter((record) => Number.isFinite(Number(record.reactionTimeMs)))
    .map((record) => normalizeReactionTime(record.reactionTimeMs))
  const correctReactionTimes = correctRecords.map((record) => (
    normalizeReactionTime(record.reactionTimeMs)
  ))
  const congruentReactionTimes = congruentRecords
    .filter((record) => record.correct)
    .map((record) => normalizeReactionTime(record.reactionTimeMs))
  const incongruentReactionTimes = incongruentRecords
    .filter((record) => record.correct)
    .map((record) => normalizeReactionTime(record.reactionTimeMs))
  const reactionTotal = reactionTimes.reduce((total, value) => total + value, 0)
  const congruentMedian = median(congruentReactionTimes)
  const incongruentMedian = median(incongruentReactionTimes)

  return {
    total_trials: validRecords.length,
    correct: correctRecords.length,
    wrong: validRecords.length - correctRecords.length,
    omissions,
    accuracy: percentage(correctRecords.length, validRecords.length),
    average_reaction_time_ms: reactionTimes.length
      ? Math.round(reactionTotal / reactionTimes.length)
      : 0,
    median_reaction_time_ms: median(correctReactionTimes),
    fastest_reaction_time_ms: reactionTimes.length
      ? Math.min(...reactionTimes)
      : 0,
    congruent_accuracy: percentage(
      congruentRecords.filter((record) => record.correct).length,
      congruentRecords.length
    ),
    incongruent_accuracy: percentage(
      incongruentRecords.filter((record) => record.correct).length,
      incongruentRecords.length
    ),
    congruent_median_reaction_time_ms: congruentMedian,
    incongruent_median_reaction_time_ms: incongruentMedian,
    interference_effect_ms: incongruentMedian - congruentMedian
  }
}

function buildStroopPayload(records, finishedAt = new Date().toISOString(), context = null) {
  const expectedLength = context ? records && records.length : STROOP_TRIALS.length
  if (!Array.isArray(records) || !records.length || records.length !== expectedLength) {
    return null
  }

  const rawResult = summarizeStroopTrials(records)
  if (rawResult.total_trials !== expectedLength) {
    return null
  }

  const payload = {
    test_type: 'stroop',
    result_json: {
      test_name: '颜色干扰任务',
      status_text: '已完成测试',
      summary: '颜色干扰任务已完成。本次结果记录冲突信息下的颜色选择正确率和反应速度。',
      metrics: [
        { label: '正确率', value: `${rawResult.accuracy}%` },
        {
          label: '平均反应时',
          value: `${rawResult.average_reaction_time_ms} ms`
        },
        { label: '正确次数', value: String(rawResult.correct) },
        { label: '错误次数', value: String(rawResult.wrong) }
      ],
      raw_result: rawResult,
      finished_at: String(finishedAt)
    }
  }
  if (context) {
    const flags = []
    if (rawResult.accuracy < 40) flags.push('low_accuracy')
    if (rawResult.omissions > Math.max(2, rawResult.total_trials * 0.15)) flags.push('high_omissions')
    Object.assign(payload.result_json, {
      schema_version: 2,
      age_group: context.ageGroup === 'adult' ? 'adult' : 'child',
      mode: context.mode === 'battery' ? 'battery' : 'single',
      quality: { valid: !flags.length, flags, interrupted_count: Number(context.interruptedCount) || 0, practice_attempts: Number(context.practiceAttempts) || 1 },
      trials: records.map((record, index) => ({ trial: index + 1, ...record }))
    })
    payload.result_json.metrics = [
      { label: '正确率', value: `${rawResult.accuracy}%` },
      { label: '中位反应时', value: `${rawResult.median_reaction_time_ms} ms` },
      { label: '干扰效应', value: `${rawResult.interference_effect_ms} ms` },
      { label: '错误次数', value: String(rawResult.wrong) }
    ]
  }
  return payload
}

module.exports = {
  COLORS,
  STROOP_TRIALS,
  buildStroopTrials,
  evaluateStroopChoice,
  summarizeStroopTrials,
  buildStroopPayload
}
