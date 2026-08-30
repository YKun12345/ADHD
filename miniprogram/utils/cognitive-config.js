const TASK_ORDER = Object.freeze([
  'reaction',
  'simple_reaction',
  'stroop',
  'trail',
  'flanker',
  'nback',
  'digit'
])

const BASE_CONFIG = Object.freeze({
  reaction: Object.freeze({ practiceTrials: 10, responseWindowMs: 1200, goRatio: 0.8 }),
  simple_reaction: Object.freeze({ practiceTrials: 8, minDelayMs: 1000, maxDelayMs: 2500, responseWindowMs: 1200 }),
  stroop: Object.freeze({ practiceTrials: 12, responseWindowMs: 2500 }),
  trail: Object.freeze({ practiceNodes: 6 }),
  flanker: Object.freeze({ practiceTrials: 12, responseWindowMs: 1800 }),
  nback: Object.freeze({ practiceTrials: 10, responseWindowMs: 2000, targetRatio: 1 / 3 }),
  digit: Object.freeze({ minSpan: 3, trialsPerSpan: 2, digitDurationMs: 800, gapMs: 250 })
})

const AGE_CONFIG = Object.freeze({
  child: Object.freeze({
    reaction: Object.freeze({ formalTrials: 80, blockSize: 40 }),
    simple_reaction: Object.freeze({ formalTrials: 24, blockSize: 12 }),
    stroop: Object.freeze({ formalTrials: 60, blockSize: 30, congruentRatio: 2 / 3 }),
    trail: Object.freeze({ partANodes: 15, partBPairs: 8 }),
    flanker: Object.freeze({ formalTrials: 48, blockSize: 24 }),
    nback: Object.freeze({ formalTrials: 45, blockSize: 45 }),
    digit: Object.freeze({ maxSpan: 8 })
  }),
  adult: Object.freeze({
    reaction: Object.freeze({ formalTrials: 120, blockSize: 40 }),
    simple_reaction: Object.freeze({ formalTrials: 30, blockSize: 15 }),
    stroop: Object.freeze({ formalTrials: 96, blockSize: 32, congruentRatio: 0.75 }),
    trail: Object.freeze({ partANodes: 25, partBPairs: 13 }),
    flanker: Object.freeze({ formalTrials: 96, blockSize: 48 }),
    nback: Object.freeze({ formalTrials: 90, blockSize: 45 }),
    digit: Object.freeze({ maxSpan: 9 })
  })
})

function resolveAgeGroup(user) {
  const profile = user && user.patient_profile && typeof user.patient_profile === 'object'
    ? user.patient_profile
    : user || {}
  const value = String(profile.patient_type || '').toLowerCase()
  return value === 'adult' ? 'adult' : 'child'
}

function getTaskConfig(taskId, ageGroup) {
  if (!TASK_ORDER.includes(taskId)) return null
  const group = ageGroup === 'adult' ? 'adult' : 'child'
  return Object.freeze({
    ...BASE_CONFIG[taskId],
    ...AGE_CONFIG[group][taskId],
    taskId,
    ageGroup: group,
    schemaVersion: 2,
    practicePassPercent: 75,
    maxPracticeAttempts: 3
  })
}

module.exports = {
  TASK_ORDER,
  resolveAgeGroup,
  getTaskConfig
}
