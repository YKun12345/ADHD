const assert = require('node:assert/strict')

const { buildGoNoGoTrials } = require('../utils/gonogo-test')
const { buildDelaySequence } = require('../utils/simple-reaction-test')
const { buildStroopTrials } = require('../utils/stroop-test')
const { buildFlankerTrials } = require('../utils/flanker-test')
const { buildNBackTrials } = require('../utils/nback-test')
const { buildDigitTrials } = require('../utils/digit-span-test')
const { buildTrailSequence, createRandomTrailLayout } = require('../utils/trail-test')

function repeatingRandom(values) {
  let index = 0
  return () => {
    const value = values[index % values.length]
    index += 1
    return value
  }
}

const lowRandom = () => repeatingRandom([0.07, 0.19, 0.31, 0.43])
const highRandom = () => repeatingRandom([0.91, 0.79, 0.67, 0.55])

const goA = buildGoNoGoTrials(25, lowRandom())
const goB = buildGoNoGoTrials(25, highRandom())
assert.notDeepEqual(goA, goB)
assert.equal(goA.filter((type) => type === 'go').length, 20)
assert.equal(goA.filter((type) => type === 'nogo').length, 5)

const delaysA = buildDelaySequence(20, 1000, 2500, lowRandom())
const delaysB = buildDelaySequence(20, 1000, 2500, highRandom())
assert.notDeepEqual(delaysA, delaysB)
assert.deepEqual(delaysA.slice().sort((a, b) => a - b), delaysB.slice().sort((a, b) => a - b))

const stroopA = buildStroopTrials(24, 0.75, lowRandom())
const stroopB = buildStroopTrials(24, 0.75, highRandom())
assert.notDeepEqual(stroopA, stroopB)
assert.equal(stroopA.filter((trial) => trial.wordKey === trial.colorKey).length, 18)
assert.equal(new Set(stroopA.map((trial) => trial.colorKey)).size, 4)

const flankerA = buildFlankerTrials(24, lowRandom())
const flankerB = buildFlankerTrials(24, highRandom())
assert.notDeepEqual(flankerA, flankerB)
assert.deepEqual(
  flankerA.reduce((counts, trial) => ({ ...counts, [trial.condition]: (counts[trial.condition] || 0) + 1 }), {}),
  { congruent: 8, incongruent: 8, neutral: 8 }
)
assert.equal(flankerA.filter((trial) => trial.target === 'left').length, 12)

const nbackA = buildNBackTrials(24, lowRandom())
const nbackB = buildNBackTrials(24, highRandom())
assert.notDeepEqual(nbackA, nbackB)
assert.equal(nbackA.slice(2).filter((trial) => trial.isTarget).length, 7)

const digitA = buildDigitTrials(3, 5, 2, lowRandom())
const digitB = buildDigitTrials(3, 5, 2, highRandom())
assert.notDeepEqual(digitA, digitB)
assert.deepEqual(digitA.map((trial) => [trial.direction, trial.span, trial.attempt]), digitB.map((trial) => [trial.direction, trial.span, trial.attempt]))

const trailSequence = buildTrailSequence('B', 6)
const trailA = createRandomTrailLayout(trailSequence, lowRandom())
const trailB = createRandomTrailLayout(trailSequence, highRandom())
assert.notDeepEqual(trailA, trailB)
assert.deepEqual(trailA.map((node) => node.label), trailSequence)
assert.deepEqual(trailB.map((node) => node.label), trailSequence)

console.log('七类认知任务受约束随机化测试全部通过')
