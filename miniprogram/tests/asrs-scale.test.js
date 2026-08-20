const assert = require('node:assert/strict')

const {
  ASRS_DRAFT_KEY,
  ASRS_CONFIG,
  normalizeDraftAnswers,
  setAnswer,
  getQuestionState,
  buildScalePayload
} = require('../utils/asrs-scale')

assert.equal(ASRS_DRAFT_KEY, 'scale_draft_asrs')
assert.equal(ASRS_CONFIG.scaleType, 'ASRS')
assert.equal(ASRS_CONFIG.respondentType, 'self')
assert.equal(ASRS_CONFIG.questions.length, 18)
assert.deepEqual(
  ASRS_CONFIG.options.map((item) => item.value),
  [0, 1, 2, 3, 4]
)
assert.deepEqual(
  ASRS_CONFIG.options.map((item) => item.label),
  ['从不', '很少', '有时', '经常', '非常频繁']
)

assert.deepEqual(normalizeDraftAnswers(null), [])
assert.deepEqual(normalizeDraftAnswers([0, 1, 9, 2]), [0, 1])
assert.deepEqual(normalizeDraftAnswers([0, '1', 2]), [0])
assert.equal(
  normalizeDraftAnswers(Array(25).fill(2)).length,
  18
)

const originalAnswers = [0, 1]
const changedAnswers = setAnswer(originalAnswers, 1, 4)
assert.deepEqual(originalAnswers, [0, 1])
assert.deepEqual(changedAnswers, [0, 4])
assert.deepEqual(setAnswer([], 0, 2), [2])
assert.deepEqual(setAnswer([0], -1, 2), [0])
assert.deepEqual(setAnswer([0], 0, 5), [0])

assert.deepEqual(getQuestionState(0, []), {
  currentIndex: 0,
  questionNumber: 1,
  totalQuestions: 18,
  currentQuestion: ASRS_CONFIG.questions[0],
  selectedValue: null,
  progressPercent: 6,
  isFirstQuestion: true,
  isLastQuestion: false
})

assert.deepEqual(getQuestionState(99, Array(18).fill(3)), {
  currentIndex: 17,
  questionNumber: 18,
  totalQuestions: 18,
  currentQuestion: ASRS_CONFIG.questions[17],
  selectedValue: 3,
  progressPercent: 100,
  isFirstQuestion: false,
  isLastQuestion: true
})

assert.equal(buildScalePayload(Array(17).fill(0)), null)
assert.equal(
  buildScalePayload([...Array(17).fill(0), 8]),
  null
)
assert.deepEqual(buildScalePayload(Array(18).fill(0)), {
  scale_type: 'ASRS',
  respondent_type: 'self',
  answers: Array(18).fill(0)
})

console.log('ASRS 量表数据测试全部通过')
