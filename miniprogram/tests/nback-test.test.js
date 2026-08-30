const assert = require('node:assert/strict')
const {
  buildNBackTrials,
  evaluateNBackAnswer,
  summarizeNBackTrials,
  buildNBackPayload
} = require('../utils/nback-test')

const trials = buildNBackTrials(45)
assert.equal(trials.length, 45)
assert.equal(trials.slice(2).filter((trial) => trial.isTarget).length >= 13, true)
assert.equal(trials.slice(2).filter((trial) => trial.isTarget).length <= 15, true)
const controlledNBack = buildNBackTrials(20, () => 0)
assert.notDeepEqual(
  controlledNBack.map((trial, index) => trial.isTarget ? index : null).filter((value) => value !== null),
  [2, 5, 8, 11, 14, 17]
)
for (let index = 2; index < trials.length; index += 1) {
  assert.equal(
    trials[index].position === trials[index - 1].position && trials[index].position === trials[index - 2].position,
    false
  )
}
assert.equal(evaluateNBackAnswer({ isTarget: true }, true, 500).outcome, 'hit')
assert.equal(evaluateNBackAnswer({ isTarget: false }, true, 500).outcome, 'false_alarm')
assert.deepEqual(evaluateNBackAnswer({ isTarget: false }, null, null), {
  isTarget: false,
  answeredMatch: null,
  outcome: 'omission',
  correct: false,
  responseTimeMs: null
})

const summary = summarizeNBackTrials([
  { outcome: 'hit', correct: true, responseTimeMs: 500 },
  { outcome: 'miss', correct: false, responseTimeMs: null },
  { outcome: 'false_alarm', correct: false, responseTimeMs: 600 },
  { outcome: 'correct_rejection', correct: true, responseTimeMs: 550 },
  { outcome: 'omission', correct: false, responseTimeMs: null }
])
assert.equal(summary.hits, 1)
assert.equal(summary.misses, 1)
assert.equal(summary.false_alarms, 1)
assert.equal(summary.correct_rejections, 1)
assert.equal(summary.omissions, 1)
assert.equal(summary.accuracy, 40)
assert.equal(Number.isFinite(summary.d_prime), true)
assert.equal(buildNBackPayload(summary, [], { ageGroup: 'child' }).test_type, 'nback')

console.log('2-back 测试数据测试全部通过')
