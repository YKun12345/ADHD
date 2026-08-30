const assert = require('node:assert/strict')
const {
  buildDigitTrials,
  expectedDigitAnswer,
  evaluateDigitTrial,
  summarizeDigitTrials,
  buildDigitSpanPayload
} = require('../utils/digit-span-test')

const trials = buildDigitTrials(3, 5, 2, () => 0.25)
assert.equal(trials.length, 12)
assert.equal(trials.filter((trial) => trial.direction === 'forward').length, 6)
assert.equal(trials.filter((trial) => trial.direction === 'backward').length, 6)
assert.equal(trials.every((trial) => trial.sequence.every((digit, index) => index === 0 || digit !== trial.sequence[index - 1])), true)
assert.deepEqual(expectedDigitAnswer({ direction: 'forward', sequence: [1, 2, 3] }), [1, 2, 3])
assert.deepEqual(expectedDigitAnswer({ direction: 'backward', sequence: [1, 2, 3] }), [3, 2, 1])
assert.equal(evaluateDigitTrial({ direction: 'forward', sequence: [1, 2] }, [1, 2]).correct, true)

const summary = summarizeDigitTrials([
  { direction: 'forward', span: 3, correct: true, correctDigits: 3 },
  { direction: 'forward', span: 4, correct: false, correctDigits: 2 },
  { direction: 'backward', span: 3, correct: true, correctDigits: 3 },
  { direction: 'backward', span: 4, correct: true, correctDigits: 4 }
])
assert.equal(summary.forward_max_span, 3)
assert.equal(summary.backward_max_span, 4)
assert.equal(summary.correct_trials, 3)
assert.equal(summary.accuracy, 75)
assert.equal(buildDigitSpanPayload(summary, [], { ageGroup: 'adult' }).test_type, 'digit')

console.log('数字广度测试数据测试全部通过')
