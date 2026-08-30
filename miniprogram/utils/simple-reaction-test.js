function round(value) {
  return Math.round(Number(value) || 0)
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values) {
  if (!values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function buildDelaySequence(count, minDelayMs, maxDelayMs, random = Math.random) {
  const size = Math.max(0, Math.floor(count))
  const min = Math.max(0, round(minDelayMs))
  const max = Math.max(min, round(maxDelayMs))
  const span = max - min
  const values = Array.from({ length: size }, (_, index) => (
    round(min + ((index + 0.5) / Math.max(1, size)) * span)
  ))
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = Math.min(index, Math.max(0, Math.floor(random() * (index + 1))))
    const value = values[index]
    values[index] = values[target]
    values[target] = value
  }
  return values
}

function evaluateReactionTrial({ clickedEarly = false, responseTimeMs = null } = {}) {
  if (clickedEarly) return { outcome: 'early', correct: false, responseTimeMs: null }
  if (responseTimeMs === null || responseTimeMs === undefined || !Number.isFinite(Number(responseTimeMs))) {
    return { outcome: 'omission', correct: false, responseTimeMs: null }
  }
  return {
    outcome: 'correct',
    correct: true,
    responseTimeMs: Math.max(0, round(responseTimeMs))
  }
}

function summarizeReactionTrials(trials) {
  const safeTrials = Array.isArray(trials) ? trials : []
  const responseTimes = safeTrials
    .filter((trial) => trial.correct && Number.isFinite(trial.responseTimeMs))
    .map((trial) => trial.responseTimeMs)
  const mean = average(responseTimes)
  const variance = average(responseTimes.map((value) => (value - mean) ** 2))
  return {
    total_trials: safeTrials.length,
    correct_trials: safeTrials.filter((trial) => trial.correct).length,
    accuracy: safeTrials.length ? round((responseTimes.length / safeTrials.length) * 100) : 0,
    average_reaction_time_ms: round(mean),
    median_reaction_time_ms: round(median(responseTimes)),
    fastest_reaction_time_ms: responseTimes.length ? Math.min(...responseTimes) : 0,
    slowest_reaction_time_ms: responseTimes.length ? Math.max(...responseTimes) : 0,
    reaction_time_variability_ms: round(Math.sqrt(variance)),
    false_starts: safeTrials.filter((trial) => trial.outcome === 'early').length,
    omissions: safeTrials.filter((trial) => trial.outcome === 'omission').length
  }
}

function buildSimpleReactionPayload(summary, trials, context = {}, finishedAt = new Date().toISOString()) {
  const flags = []
  if (summary.false_starts > Math.max(2, summary.total_trials * 0.15)) flags.push('high_false_starts')
  if (summary.omissions > Math.max(2, summary.total_trials * 0.15)) flags.push('high_omissions')
  return {
    test_type: 'simple_reaction',
    result_json: {
      schema_version: 2,
      test_name: '简单反应时测试',
      status_text: flags.length ? '已完成（需关注数据质量）' : '已完成',
      age_group: context.ageGroup === 'adult' ? 'adult' : 'child',
      mode: context.mode === 'battery' ? 'battery' : 'single',
      summary: `有效反应 ${summary.correct_trials}/${summary.total_trials} 次`,
      metrics: [
        { label: '中位反应时', value: `${summary.median_reaction_time_ms} ms` },
        { label: '有效率', value: `${summary.accuracy}%` }
      ],
      raw_result: summary,
      quality: {
        valid: flags.length === 0,
        flags,
        interrupted_count: Number(context.interruptedCount) || 0,
        practice_attempts: Number(context.practiceAttempts) || 1
      },
      trials: Array.isArray(trials) ? trials : [],
      finished_at: finishedAt
    }
  }
}

module.exports = {
  buildDelaySequence,
  evaluateReactionTrial,
  summarizeReactionTrials,
  buildSimpleReactionPayload
}
