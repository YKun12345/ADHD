const TRIAL_SEQUENCE = Object.freeze([
  'go',
  'go',
  'nogo',
  'go',
  'nogo',
  'go',
  'go',
  'nogo',
  'go',
  'nogo'
])

function shuffled(values, random) {
  const result = values.slice()
  for (let index = result.length - 1; index > 0; index -= 1) {
    const sample = Number(random())
    const target = Math.min(index, Math.max(0, Math.floor((Number.isFinite(sample) ? sample : 0) * (index + 1))))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

function buildGoNoGoTrials(count, random = Math.random) {
  const size = Math.max(0, Math.floor(count / 5) * 5)
  const noGoCount = size / 5
  return shuffled([
    ...Array.from({ length: size - noGoCount }, () => 'go'),
    ...Array.from({ length: noGoCount }, () => 'nogo')
  ], random)
}

function normalizeReactionTime(value) {
  const number = Number(value)

  if (!Number.isFinite(number)) {
    return 0
  }

  return Math.max(0, Math.round(number))
}

function evaluateTrial({ type, action, reactionTimeMs } = {}) {
  if (!TRIAL_SEQUENCE.includes(type)) {
    return null
  }

  if (action === 'false_start') {
    return {
      type,
      action,
      correct: false,
      reactionTimeMs: null,
      errorType: 'false_start'
    }
  }

  if (action !== 'tap' && action !== 'timeout') {
    return null
  }

  if (type === 'go' && action === 'tap') {
    return {
      type,
      action,
      correct: true,
      reactionTimeMs: normalizeReactionTime(reactionTimeMs),
      errorType: null
    }
  }

  if (type === 'go') {
    return {
      type,
      action,
      correct: false,
      reactionTimeMs: null,
      errorType: 'omission'
    }
  }

  if (action === 'tap') {
    return {
      type,
      action,
      correct: false,
      reactionTimeMs: null,
      errorType: 'commission'
    }
  }

  return {
    type,
    action,
    correct: true,
    reactionTimeMs: null,
    errorType: null
  }
}

function percentage(value, total) {
  if (!total) {
    return 0
  }

  return Math.round((value / total) * 100)
}

function summarizeTrials(records = []) {
  const validRecords = Array.isArray(records)
    ? records.filter((record) => record && TRIAL_SEQUENCE.includes(record.type))
    : []
  const goRecords = validRecords.filter((record) => record.type === 'go')
  const nogoRecords = validRecords.filter((record) => record.type === 'nogo')
  const correctRecords = validRecords.filter((record) => record.correct === true)
  const reactionTimes = goRecords
    .filter((record) => record.correct === true && record.action === 'tap')
    .map((record) => normalizeReactionTime(record.reactionTimeMs))
  const reactionTotal = reactionTimes.reduce((total, value) => total + value, 0)

  return {
    total_trials: validRecords.length,
    correct_trials: correctRecords.length,
    accuracy: percentage(correctRecords.length, validRecords.length),
    go_accuracy: percentage(
      goRecords.filter((record) => record.correct === true).length,
      goRecords.length
    ),
    nogo_accuracy: percentage(
      nogoRecords.filter((record) => record.correct === true).length,
      nogoRecords.length
    ),
    average_reaction_time_ms: reactionTimes.length
      ? Math.round(reactionTotal / reactionTimes.length)
      : 0,
    fastest_reaction_time_ms: reactionTimes.length
      ? Math.min(...reactionTimes)
      : 0,
    commission_errors: validRecords.filter(
      (record) => record.errorType === 'commission'
    ).length,
    omission_errors: validRecords.filter(
      (record) => record.errorType === 'omission'
    ).length,
    false_starts: validRecords.filter(
      (record) => record.errorType === 'false_start'
    ).length
  }
}

function buildCognitivePayload(records, finishedAt = new Date().toISOString(), context = null) {
  const expectedLength = context ? records && records.length : TRIAL_SEQUENCE.length
  if (!Array.isArray(records) || !records.length || records.length !== expectedLength) {
    return null
  }

  const rawResult = summarizeTrials(records)
  if (rawResult.total_trials !== expectedLength) {
    return null
  }

  const payload = {
    test_type: 'reaction',
    result_json: {
      test_name: '反应抑制任务',
      status_text: '已完成测试',
      summary: '反应抑制任务已完成。本次结果记录反应速度、注意保持和抑制控制的客观表现。',
      metrics: [
        { label: '正确率', value: `${rawResult.accuracy}%` },
        {
          label: '平均反应时',
          value: `${rawResult.average_reaction_time_ms} ms`
        },
        { label: '冲动错误', value: String(rawResult.commission_errors) },
        { label: '提前误触', value: String(rawResult.false_starts) }
      ],
      test_variant: 'go_nogo',
      raw_result: rawResult,
      finished_at: String(finishedAt)
    }
  }
  if (context) {
    const flags = []
    if (rawResult.omission_errors > rawResult.total_trials * 0.15) flags.push('high_omissions')
    if (rawResult.false_starts > rawResult.total_trials * 0.15) flags.push('high_false_starts')
    Object.assign(payload.result_json, {
      schema_version: 2,
      age_group: context.ageGroup === 'adult' ? 'adult' : 'child',
      mode: context.mode === 'battery' ? 'battery' : 'single',
      quality: { valid: !flags.length, flags, interrupted_count: Number(context.interruptedCount) || 0, practice_attempts: Number(context.practiceAttempts) || 1 },
      trials: records.map((record, index) => ({ trial: index + 1, ...record }))
    })
  }
  return payload
}

module.exports = {
  TRIAL_SEQUENCE,
  buildGoNoGoTrials,
  evaluateTrial,
  summarizeTrials,
  buildCognitivePayload
}
