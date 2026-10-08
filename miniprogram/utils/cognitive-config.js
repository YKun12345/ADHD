const TASK_ORDER = Object.freeze([
  'reaction',
  'stroop',
  'flanker',
  'nback',
  'trail',
  'digit'
])

const BASE_CONFIG = Object.freeze({
  reaction: Object.freeze({ practiceTrials: 5, responseWindowMs: 800, goRatio: 0.8 }),
  stroop: Object.freeze({ practiceTrials: 8, responseWindowMs: 2500 }),
  trail: Object.freeze({ practiceNodes: 4 }),
  flanker: Object.freeze({ practiceTrials: 8, responseWindowMs: 1800 }),
  nback: Object.freeze({ practiceTrials: 6, responseWindowMs: 2000, targetRatio: 1 / 3 }),
  digit: Object.freeze({ minSpan: 3, trialsPerSpan: 2, digitDurationMs: 800, gapMs: 250 })
})

const AGE_CONFIG = Object.freeze({
  child: Object.freeze({
    reaction: Object.freeze({ formalTrials: 25, blockSize: 25 }),
    stroop: Object.freeze({ formalTrials: 24, blockSize: 24, congruentRatio: 2 / 3 }),
    trail: Object.freeze({ partANodes: 30, partBPairs: 15 }),
    flanker: Object.freeze({ formalTrials: 24, blockSize: 24 }),
    nback: Object.freeze({ formalTrials: 24, blockSize: 24 }),
    digit: Object.freeze({ maxSpan: 7 })
  }),
  adult: Object.freeze({
    reaction: Object.freeze({ formalTrials: 25, blockSize: 25 }),
    stroop: Object.freeze({ formalTrials: 24, blockSize: 24, congruentRatio: 0.75 }),
    trail: Object.freeze({ partANodes: 30, partBPairs: 15 }),
    flanker: Object.freeze({ formalTrials: 24, blockSize: 24 }),
    nback: Object.freeze({ formalTrials: 24, blockSize: 24 }),
    digit: Object.freeze({ maxSpan: 8 })
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
    schemaVersion: 6,
    protocolId: 'continuous-mobile-v4',
    protocolLabel: '连续移动筛查版',
    practicePassPercent: 75,
    maxPracticeAttempts: 3
  })
}

module.exports = {
  TASK_ORDER,
  resolveAgeGroup,
  getTaskConfig
}
