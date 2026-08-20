function validateConfiguration(config) {
  return Boolean(
    config &&
    typeof config.scaleType === 'string' &&
    typeof config.respondentType === 'string' &&
    Number.isInteger(config.maxScore) &&
    config.maxScore >= 0 &&
    Array.isArray(config.questions) &&
    config.questions.length > 0
  )
}

function createScaleSession(config) {
  if (!validateConfiguration(config)) {
    throw new Error('Invalid scale configuration')
  }

  const totalQuestions = config.questions.length

  function isValidAnswer(value) {
    return Number.isInteger(value) &&
      value >= 0 &&
      value <= config.maxScore
  }

  function normalizeDraftAnswers(value) {
    if (!Array.isArray(value)) {
      return []
    }

    const answers = []
    const maximumLength = Math.min(value.length, totalQuestions)

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
      index >= totalQuestions ||
      !isValidAnswer(value)
    ) {
      return nextAnswers
    }

    nextAnswers[index] = value
    return nextAnswers
  }

  function getQuestionState(index, answers = []) {
    const lastIndex = totalQuestions - 1
    const currentIndex = Number.isInteger(index)
      ? Math.min(lastIndex, Math.max(0, index))
      : 0
    const selectedValue = isValidAnswer(answers[currentIndex])
      ? answers[currentIndex]
      : null

    return {
      currentIndex,
      questionNumber: currentIndex + 1,
      totalQuestions,
      currentQuestion: config.questions[currentIndex],
      selectedValue,
      progressPercent: Math.round(
        ((currentIndex + 1) / totalQuestions) * 100
      ),
      isFirstQuestion: currentIndex === 0,
      isLastQuestion: currentIndex === lastIndex
    }
  }

  function buildScalePayload(answers) {
    if (
      !Array.isArray(answers) ||
      answers.length !== totalQuestions ||
      !answers.every(isValidAnswer)
    ) {
      return null
    }

    return {
      scale_type: config.scaleType,
      respondent_type: config.respondentType,
      answers: answers.slice()
    }
  }

  return {
    normalizeDraftAnswers,
    setAnswer,
    getQuestionState,
    buildScalePayload
  }
}

module.exports = {
  createScaleSession
}
