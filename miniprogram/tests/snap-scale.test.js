const assert = require('node:assert/strict')

const {
  SNAP_DRAFT_KEY,
  SNAP_CONFIG,
  normalizeDraftAnswers,
  setAnswer,
  getQuestionState,
  buildScalePayload
} = require('../utils/snap-scale')

assert.equal(SNAP_DRAFT_KEY, 'scale_draft_snap_iv')
assert.equal(SNAP_CONFIG.scaleType, 'SNAP_IV')
assert.equal(SNAP_CONFIG.respondentType, 'parent')
assert.equal(SNAP_CONFIG.maxScore, 3)
assert.equal(SNAP_CONFIG.questions.length, 26)
assert.deepEqual(
  SNAP_CONFIG.options.map((item) => item.value),
  [0, 1, 2, 3]
)
assert.deepEqual(
  SNAP_CONFIG.options.map((item) => item.label),
  ['从不', '偶尔', '经常', '非常频繁']
)

assert.match(SNAP_CONFIG.questions[0], /不注意细节/)
assert.match(SNAP_CONFIG.questions[8], /忘记/)
assert.match(SNAP_CONFIG.questions[17], /打断别人/)
assert.match(SNAP_CONFIG.questions[25], /报复/)

assert.deepEqual(normalizeDraftAnswers([0, 1, 3, 4, 2]), [0, 1, 3])
assert.deepEqual(normalizeDraftAnswers([0, '1']), [0])
assert.equal(normalizeDraftAnswers(Array(30).fill(2)).length, 26)

const original = [0]
const changed = setAnswer(original, 1, 3)
assert.deepEqual(original, [0])
assert.deepEqual(changed, [0, 3])
assert.deepEqual(setAnswer([0], 0, 4), [0])

const lastQuestion = getQuestionState(25, Array(26).fill(1))
assert.equal(lastQuestion.questionNumber, 26)
assert.equal(lastQuestion.totalQuestions, 26)
assert.equal(lastQuestion.progressPercent, 100)
assert.equal(lastQuestion.selectedValue, 1)
assert.equal(lastQuestion.isLastQuestion, true)

assert.equal(buildScalePayload(Array(25).fill(0)), null)
assert.deepEqual(buildScalePayload(Array(26).fill(3)), {
  scale_type: 'SNAP_IV',
  respondent_type: 'parent',
  answers: Array(26).fill(3)
})

console.log('SNAP-IV 量表数据测试全部通过')
