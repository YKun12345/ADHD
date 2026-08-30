function buildSequence(span, random) {
  const values = []
  while (values.length < span) {
    let digit = Math.max(0, Math.min(9, Math.floor(random() * 10)))
    if (values.length && digit === values[values.length - 1]) digit = (digit + values.length + 1) % 10
    values.push(digit)
  }
  return values
}

function buildDigitTrials(minSpan, maxSpan, trialsPerSpan, random = Math.random) {
  const trials = []
  for (const direction of ['forward', 'backward']) {
    for (let span = minSpan; span <= maxSpan; span += 1) {
      for (let attempt = 1; attempt <= trialsPerSpan; attempt += 1) {
        trials.push({ id: `${direction}-${span}-${attempt}`, direction, span, attempt, sequence: buildSequence(span, random) })
      }
    }
  }
  return trials
}

function expectedDigitAnswer(trial) {
  return trial.direction === 'backward' ? trial.sequence.slice().reverse() : trial.sequence.slice()
}

function evaluateDigitTrial(trial, answer) {
  const expected = expectedDigitAnswer(trial)
  const safeAnswer = Array.isArray(answer) ? answer.map(Number) : []
  const correctDigits = expected.reduce((count, digit, index) => count + (safeAnswer[index] === digit ? 1 : 0), 0)
  return { ...trial, answer: safeAnswer, expected, correctDigits, correct: safeAnswer.length === expected.length && correctDigits === expected.length }
}

function summarizeDigitTrials(trials) {
  const safeTrials = Array.isArray(trials) ? trials : []
  const correct = safeTrials.filter((trial) => trial.correct)
  const maxSpan = (direction) => correct.filter((trial) => trial.direction === direction).reduce((max, trial) => Math.max(max, trial.span), 0)
  return {
    total_trials: safeTrials.length,
    correct_trials: correct.length,
    accuracy: safeTrials.length ? Math.round((correct.length / safeTrials.length) * 100) : 0,
    forward_max_span: maxSpan('forward'),
    backward_max_span: maxSpan('backward'),
    correct_digits: safeTrials.reduce((sum, trial) => sum + (Number(trial.correctDigits) || 0), 0),
    total_digits: safeTrials.reduce((sum, trial) => sum + (Number(trial.span) || 0), 0)
  }
}

function buildDigitSpanPayload(summary, trials, context = {}, finishedAt = new Date().toISOString()) {
  const flags = summary.total_trials && summary.correct_trials === 0 ? ['no_correct_trials'] : []
  return {
    test_type: 'digit', result_json: {
      schema_version: 2, test_name: '数字广度测试', status_text: flags.length ? '已完成（需关注数据质量）' : '已完成',
      age_group: context.ageGroup === 'adult' ? 'adult' : 'child', mode: context.mode === 'battery' ? 'battery' : 'single', summary: `顺背 ${summary.forward_max_span} 位，倒背 ${summary.backward_max_span} 位`,
      metrics: [{ label: '顺背最大跨度', value: String(summary.forward_max_span) }, { label: '倒背最大跨度', value: String(summary.backward_max_span) }], raw_result: summary,
      quality: { valid: !flags.length, flags, interrupted_count: Number(context.interruptedCount) || 0, practice_attempts: Number(context.practiceAttempts) || 1 },
      trials: Array.isArray(trials) ? trials : [], finished_at: finishedAt
    }
  }
}

module.exports = { buildDigitTrials, expectedDigitAnswer, evaluateDigitTrial, summarizeDigitTrials, buildDigitSpanPayload }
