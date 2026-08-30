const assert = require('node:assert/strict')
const {
  buildFlankerTrials,
  evaluateFlankerTrial,
  summarizeFlankerTrials,
  buildFlankerPayload
} = require('../utils/flanker-test')

const trials = buildFlankerTrials(48)
assert.equal(trials.length, 48)
assert.deepEqual(
  trials.reduce((counts, trial) => ({ ...counts, [trial.condition]: (counts[trial.condition] || 0) + 1 }), {}),
  { congruent: 16, incongruent: 16, neutral: 16 }
)
assert.equal(trials.filter((trial) => trial.target === 'left').length, 24)
const controlledFlanker = buildFlankerTrials(12, () => 0)
assert.notDeepEqual(
  controlledFlanker.map((trial) => trial.condition),
  ['congruent', 'incongruent', 'neutral', 'congruent', 'incongruent', 'neutral', 'congruent', 'incongruent', 'neutral', 'congruent', 'incongruent', 'neutral']
)
assert.equal(controlledFlanker.filter((trial) => trial.target === 'left').length, 6)
assert.equal(evaluateFlankerTrial(trials[0], trials[0].target, 420).correct, true)
assert.equal(evaluateFlankerTrial(trials[0], '', null).outcome, 'omission')

const summary = summarizeFlankerTrials([
  { condition: 'congruent', correct: true, responseTimeMs: 300 },
  { condition: 'incongruent', correct: true, responseTimeMs: 500 },
  { condition: 'neutral', correct: false, responseTimeMs: 400 }
])
assert.equal(summary.accuracy, 67)
assert.equal(summary.conflict_effect_ms, 200)
assert.equal(summary.condition_metrics.incongruent.accuracy, 100)
assert.equal(buildFlankerPayload(summary, [], { ageGroup: 'adult' }).test_type, 'flanker')

console.log('Flanker 测试数据测试全部通过')
