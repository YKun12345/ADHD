const assert = require('node:assert/strict')

const { createScaleSession } = require('../utils/scale-session')

const session = createScaleSession({
  scaleType: 'TEST',
  respondentType: 'self',
  maxScore: 2,
  questions: ['问题1', '问题2', '问题3']
})

assert.deepEqual(session.normalizeDraftAnswers(null), [])
assert.deepEqual(
  session.normalizeDraftAnswers([0, 2, 3, 1]),
  [0, 2]
)

const original = [0]
const changed = session.setAnswer(original, 1, 2)
assert.deepEqual(original, [0])
assert.deepEqual(changed, [0, 2])
assert.deepEqual(session.setAnswer([0], 0, -1), [0])

assert.deepEqual(session.getQuestionState(1, [0, 2]), {
  currentIndex: 1,
  questionNumber: 2,
  totalQuestions: 3,
  currentQuestion: '问题2',
  selectedValue: 2,
  progressPercent: 67,
  isFirstQuestion: false,
  isLastQuestion: false
})

assert.equal(session.buildScalePayload([0, 1]), null)
assert.deepEqual(session.buildScalePayload([0, 1, 2]), {
  scale_type: 'TEST',
  respondent_type: 'self',
  answers: [0, 1, 2]
})

assert.throws(
  () => createScaleSession({}),
  /Invalid scale configuration/
)

console.log('通用量表会话测试全部通过')
