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

function buildCognitivePayload(records, finishedAt = new Date().toISOString()) {
  if (!Array.isArray(records) || records.length !== TRIAL_SEQUENCE.length) {
    return null
  }

  const rawResult = summarizeTrials(records)
  if (rawResult.total_trials !== TRIAL_SEQUENCE.length) {
    return null
  }

  return {
    test_type: 'reaction',
    result_json: {
      test_variant: 'go_nogo',
      raw_result: rawResult,
      finished_at: String(finishedAt)
    }
  }
}

module.exports = {
  TRIAL_SEQUENCE,
  evaluateTrial,
  summarizeTrials,
  buildCognitivePayload
}
