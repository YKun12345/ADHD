function median(values) {
  if (!values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
}

function shuffled(values, random) {
  const result = values.slice()
  for (let index = result.length - 1; index > 0; index -= 1) {
    const sample = Number(random())
    const target = Math.min(index, Math.max(0, Math.floor((Number.isFinite(sample) ? sample : 0) * (index + 1))))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

function buildFlankerTrials(count, random = Math.random) {
  const size = Math.max(0, Math.floor(count / 6) * 6)
  const conditions = ['congruent', 'incongruent', 'neutral']
  const trials = []
  for (let index = 0; index < size; index += 1) {
    const condition = conditions[index % 3]
    const target = Math.floor(index / 3) % 2 === 0 ? 'left' : 'right'
    trials.push({ id: index + 1, condition, target })
  }
  return shuffled(trials, random).map((trial, index) => ({ ...trial, id: index + 1 }))
}

function evaluateFlankerTrial(trial, answer, responseTimeMs) {
  if (!answer) return { ...trial, answer: '', correct: false, outcome: 'omission', responseTimeMs: null }
  const correct = answer === trial.target
  return { ...trial, answer, correct, outcome: correct ? 'correct' : 'wrong', responseTimeMs: Math.max(0, Math.round(Number(responseTimeMs) || 0)) }
}

function summarizeCondition(trials) {
  const correct = trials.filter((trial) => trial.correct)
  return {
    total: trials.length,
    accuracy: trials.length ? Math.round((correct.length / trials.length) * 100) : 0,
    median_reaction_time_ms: median(correct.map((trial) => trial.responseTimeMs).filter(Number.isFinite))
  }
}

function summarizeFlankerTrials(trials) {
  const safeTrials = Array.isArray(trials) ? trials : []
  const conditionMetrics = {
    congruent: summarizeCondition(safeTrials.filter((trial) => trial.condition === 'congruent')),
    incongruent: summarizeCondition(safeTrials.filter((trial) => trial.condition === 'incongruent')),
    neutral: summarizeCondition(safeTrials.filter((trial) => trial.condition === 'neutral'))
  }
  return {
    total_trials: safeTrials.length,
    correct_trials: safeTrials.filter((trial) => trial.correct).length,
    accuracy: safeTrials.length ? Math.round((safeTrials.filter((trial) => trial.correct).length / safeTrials.length) * 100) : 0,
    average_reaction_time_ms: median(safeTrials.filter((trial) => trial.correct).map((trial) => trial.responseTimeMs).filter(Number.isFinite)),
    conflict_effect_ms: conditionMetrics.incongruent.median_reaction_time_ms - conditionMetrics.congruent.median_reaction_time_ms,
    omissions: safeTrials.filter((trial) => trial.outcome === 'omission').length,
    condition_metrics: conditionMetrics
  }
}

function buildFlankerPayload(summary, trials, context = {}, finishedAt = new Date().toISOString()) {
  const flags = []
  if (summary.omissions > Math.max(2, summary.total_trials * 0.15)) flags.push('high_omissions')
  return {
    test_type: 'flanker',
    result_json: {
      schema_version: 2, test_name: '箭头抗干扰任务', status_text: flags.length ? '已完成（需关注数据质量）' : '已完成',
      age_group: context.ageGroup === 'adult' ? 'adult' : 'child', mode: context.mode === 'battery' ? 'battery' : 'single',
      summary: `正确率 ${summary.accuracy}%`,
      metrics: [{ label: '正确率', value: `${summary.accuracy}%` }, { label: '冲突效应', value: `${summary.conflict_effect_ms} ms` }],
      raw_result: summary, quality: { valid: !flags.length, flags, interrupted_count: Number(context.interruptedCount) || 0, practice_attempts: Number(context.practiceAttempts) || 1 },
      trials: Array.isArray(trials) ? trials : [], finished_at: finishedAt
    }
  }
}

module.exports = { buildFlankerTrials, evaluateFlankerTrial, summarizeFlankerTrials, buildFlankerPayload }
