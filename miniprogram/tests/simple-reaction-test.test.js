const assert = require('node:assert/strict')
const {
  buildDelaySequence,
  evaluateReactionTrial,
  summarizeReactionTrials,
  buildSimpleReactionPayload
} = require('../utils/simple-reaction-test')

const delays = buildDelaySequence(6, 1000, 2500, () => 0.5)
assert.equal(delays.length, 6)
assert.equal(delays.every((value) => value >= 1000 && value <= 2500), true)
assert.equal(new Set(delays).size > 1, true)
assert.equal(evaluateReactionTrial({ clickedEarly: true }).outcome, 'early')
assert.equal(evaluateReactionTrial({ responseTimeMs: 320 }).correct, true)
assert.equal(evaluateReactionTrial({ responseTimeMs: null }).outcome, 'omission')

const summary = summarizeReactionTrials([
  { outcome: 'correct', correct: true, responseTimeMs: 200 },
  { outcome: 'correct', correct: true, responseTimeMs: 300 },
  { outcome: 'correct', correct: true, responseTimeMs: 700 },
  { outcome: 'early', correct: false, responseTimeMs: null },
  { outcome: 'omission', correct: false, responseTimeMs: null }
])
assert.equal(summary.accuracy, 60)
assert.equal(summary.average_reaction_time_ms, 400)
assert.equal(summary.median_reaction_time_ms, 300)
assert.equal(summary.false_starts, 1)
assert.equal(summary.omissions, 1)

const payload = buildSimpleReactionPayload(summary, [], { ageGroup: 'adult', mode: 'battery' }, '2026-08-29T00:00:00.000Z')
assert.equal(payload.test_type, 'simple_reaction')
assert.equal(payload.result_json.schema_version, 2)
assert.equal(payload.result_json.age_group, 'adult')
assert.equal(payload.result_json.mode, 'battery')

console.log('简单反应时测试数据测试全部通过')
