function shuffled(values, random) {
  const result = values.slice()
  for (let index = result.length - 1; index > 0; index -= 1) {
    const sample = Number(random())
    const target = Math.min(index, Math.max(0, Math.floor((Number.isFinite(sample) ? sample : 0) * (index + 1))))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

function nextPosition(random, blocked) {
  const sample = Number(random())
  let position = Math.min(8, Math.max(0, Math.floor((Number.isFinite(sample) ? sample : 0) * 9)))
  while (blocked.includes(position)) position = (position + 1) % 9
  return position
}

function buildNBackTrials(count, random = Math.random) {
  const size = Math.max(2, Math.floor(count))
  const scoredCount = size - 2
  const targetCount = Math.round(scoredCount / 3)
  const targetFlags = shuffled([
    ...Array.from({ length: targetCount }, () => true),
    ...Array.from({ length: scoredCount - targetCount }, () => false)
  ], random)
  const trials = []
  for (let index = 0; index < size; index += 1) {
    let position
    const isTarget = index >= 2 && targetFlags[index - 2]
    if (isTarget) {
      position = trials[index - 2].position
    } else {
      const blocked = []
      if (index >= 1) blocked.push(trials[index - 1].position)
      if (index >= 2) blocked.push(trials[index - 2].position)
      position = nextPosition(random, blocked)
    }
    trials.push({ id: index + 1, position, isTarget: index >= 2 && position === trials[index - 2].position, scored: index >= 2 })
  }
  return trials
}

function evaluateNBackAnswer(trial, answeredMatch, responseTimeMs) {
  if (answeredMatch !== true && answeredMatch !== false) {
    return { ...trial, answeredMatch: null, outcome: 'omission', correct: false, responseTimeMs: null }
  }
  const match = Boolean(answeredMatch)
  let outcome
  if (trial.isTarget) outcome = match ? 'hit' : 'miss'
  else outcome = match ? 'false_alarm' : 'correct_rejection'
  return { ...trial, answeredMatch: match, outcome, correct: outcome === 'hit' || outcome === 'correct_rejection', responseTimeMs: Number.isFinite(Number(responseTimeMs)) ? Math.max(0, Math.round(responseTimeMs)) : null }
}

function correctedRate(successes, total) {
  return (successes + 0.5) / (total + 1)
}

function logit(value) {
  return Math.log(value / (1 - value)) / 1.7
}

function summarizeNBackTrials(trials) {
  const safeTrials = Array.isArray(trials) ? trials : []
  const hits = safeTrials.filter((trial) => trial.outcome === 'hit').length
  const misses = safeTrials.filter((trial) => trial.outcome === 'miss').length
  const falseAlarms = safeTrials.filter((trial) => trial.outcome === 'false_alarm').length
  const correctRejections = safeTrials.filter((trial) => trial.outcome === 'correct_rejection').length
  const omissions = safeTrials.filter((trial) => trial.outcome === 'omission').length
  const correct = hits + correctRejections
  const times = safeTrials.filter((trial) => trial.correct && Number.isFinite(trial.responseTimeMs)).map((trial) => trial.responseTimeMs)
  return {
    total_trials: safeTrials.length, hits, misses, false_alarms: falseAlarms, correct_rejections: correctRejections, omissions,
    accuracy: safeTrials.length ? Math.round((correct / safeTrials.length) * 100) : 0,
    average_reaction_time_ms: times.length ? Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) : 0,
    d_prime: Number((logit(correctedRate(hits, hits + misses)) - logit(correctedRate(falseAlarms, falseAlarms + correctRejections))).toFixed(2))
  }
}

function buildNBackPayload(summary, trials, context = {}, finishedAt = new Date().toISOString()) {
  const flags = []
  if (summary.accuracy < 40) flags.push('low_accuracy')
  if (summary.omissions > Math.max(2, summary.total_trials * 0.15)) flags.push('high_omissions')
  return {
    test_type: 'nback', result_json: {
      schema_version: 2, test_name: '空间 2-back 测试', status_text: flags.length ? '已完成（需关注数据质量）' : '已完成',
      age_group: context.ageGroup === 'adult' ? 'adult' : 'child', mode: context.mode === 'battery' ? 'battery' : 'single', summary: `正确率 ${summary.accuracy}%`,
      metrics: [{ label: '正确率', value: `${summary.accuracy}%` }, { label: '辨别指数', value: String(summary.d_prime) }], raw_result: summary,
      quality: { valid: !flags.length, flags, interrupted_count: Number(context.interruptedCount) || 0, practice_attempts: Number(context.practiceAttempts) || 1 },
      trials: Array.isArray(trials) ? trials : [], finished_at: finishedAt
    }
  }
}

module.exports = { buildNBackTrials, evaluateNBackAnswer, summarizeNBackTrials, buildNBackPayload }
