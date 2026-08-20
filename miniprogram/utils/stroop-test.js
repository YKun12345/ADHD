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
  if (!isValidTrial(trial) || !COLOR_KEYS.includes(selectedKey)) {
    return null
  }

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

function summarizeStroopTrials(records = []) {
  const validRecords = Array.isArray(records)
    ? records.filter((record) => (
        record &&
        COLOR_KEYS.includes(record.wordKey) &&
        COLOR_KEYS.includes(record.colorKey) &&
        COLOR_KEYS.includes(record.selectedKey) &&
        typeof record.correct === 'boolean'
      ))
    : []
  const correctRecords = validRecords.filter((record) => record.correct)
  const congruentRecords = validRecords.filter((record) => record.congruent)
  const incongruentRecords = validRecords.filter((record) => !record.congruent)
  const reactionTimes = validRecords.map((record) => (
    normalizeReactionTime(record.reactionTimeMs)
  ))
  const reactionTotal = reactionTimes.reduce((total, value) => total + value, 0)

  return {
    total_trials: validRecords.length,
    correct: correctRecords.length,
    wrong: validRecords.length - correctRecords.length,
    accuracy: percentage(correctRecords.length, validRecords.length),
    average_reaction_time_ms: reactionTimes.length
      ? Math.round(reactionTotal / reactionTimes.length)
      : 0,
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
    )
  }
}

function buildStroopPayload(records, finishedAt = new Date().toISOString()) {
  if (!Array.isArray(records) || records.length !== STROOP_TRIALS.length) {
    return null
  }

  const rawResult = summarizeStroopTrials(records)
  if (rawResult.total_trials !== STROOP_TRIALS.length) {
    return null
  }

  return {
    test_type: 'stroop',
    result_json: {
      test_name: 'Stroop 测试',
      status_text: '已完成测试',
      summary: 'Stroop 测试已完成。本次结果记录冲突信息下的颜色选择正确率和反应速度。',
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
}

module.exports = {
  COLORS,
  STROOP_TRIALS,
  evaluateStroopChoice,
  summarizeStroopTrials,
  buildStroopPayload
}
