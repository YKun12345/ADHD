const ASRS_DRAFT_KEY = 'scale_draft_asrs'

const ASRS_CONFIG = {
  title: 'ASRS 成人自评量表',
  scaleType: 'ASRS',
  respondentType: 'self',
  estimatedMinutes: 5,
  options: [
    { label: '从不', value: 0 },
    { label: '很少', value: 1 },
    { label: '有时', value: 2 },
    { label: '经常', value: 3 },
    { label: '非常频繁', value: 4 }
  ],
  questions: [
    '你是否经常在任务临近结束时，难以把最后的细节收尾完善？',
    '当事情需要按步骤规划时，你是否经常难以把安排整理清楚？',
    '你是否经常忘记预约、截止时间或已经答应别人的事情？',
    '面对需要长时间动脑的任务时，你是否常常拖延开始？',
    '当你需要长时间坐着时，是否常常不自觉地扭动或坐立不安？',
    '你是否常常感到自己像被什么推动着一样，很难真正慢下来？',
    '在阅读、开会或上课时，你是否很容易被周围声音或想法打断？',
    '你是否经常同时开始很多事，但难以把它们完整收尾？',
    '你是否常常把钥匙、手机、证件或其他必需品放错地方？',
    '当事情需要持续投入一段时间时，你是否很难一直保持注意力？',
    '你是否常常因为分心而在做事中途切换到别的事情？',
    '你是否经常把需要完成的事情拖到最后一刻才动手？',
    '你是否在本该安静的场合仍然会不自觉说很多话或动个不停？',
    '你是否常常在需要排队或等待时感到特别难熬？',
    '别人还没说完时，你是否经常急着插话或先把答案说出来？',
    '你是否常因一时冲动答应、购买或决定一些事，之后再后悔？',
    '当任务枯燥但重要时，你是否很难启动并坚持到底？',
    '你是否觉得自己经常“知道该做什么”，但就是很难真正去做？'
  ]
}

function isValidAnswer(value) {
  return Number.isInteger(value) && value >= 0 && value <= 4
}

function normalizeDraftAnswers(value) {
  if (!Array.isArray(value)) {
    return []
  }

  const answers = []
  const maximumLength = Math.min(
    value.length,
    ASRS_CONFIG.questions.length
  )

  for (let index = 0; index < maximumLength; index += 1) {
    if (!isValidAnswer(value[index])) {
      break
    }

    answers.push(value[index])
  }

  return answers
}

function setAnswer(answers, index, value) {
  const nextAnswers = Array.isArray(answers)
    ? answers.slice()
    : []

  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= ASRS_CONFIG.questions.length ||
    !isValidAnswer(value)
  ) {
    return nextAnswers
  }

  nextAnswers[index] = value
  return nextAnswers
}

function getQuestionState(index, answers = []) {
  const lastIndex = ASRS_CONFIG.questions.length - 1
  const currentIndex = Number.isInteger(index)
    ? Math.min(lastIndex, Math.max(0, index))
    : 0
  const selectedValue = isValidAnswer(answers[currentIndex])
    ? answers[currentIndex]
    : null

  return {
    currentIndex,
    questionNumber: currentIndex + 1,
    totalQuestions: ASRS_CONFIG.questions.length,
    currentQuestion: ASRS_CONFIG.questions[currentIndex],
    selectedValue,
    progressPercent: Math.round(
      ((currentIndex + 1) / ASRS_CONFIG.questions.length) * 100
    ),
    isFirstQuestion: currentIndex === 0,
    isLastQuestion: currentIndex === lastIndex
  }
}

function buildScalePayload(answers) {
  if (
    !Array.isArray(answers) ||
    answers.length !== ASRS_CONFIG.questions.length ||
    !answers.every(isValidAnswer)
  ) {
    return null
  }

  return {
    scale_type: ASRS_CONFIG.scaleType,
    respondent_type: ASRS_CONFIG.respondentType,
    answers: answers.slice()
  }
}

module.exports = {
  ASRS_DRAFT_KEY,
  ASRS_CONFIG,
  normalizeDraftAnswers,
  setAnswer,
  getQuestionState,
  buildScalePayload
}
