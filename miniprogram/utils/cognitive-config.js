const TASK_ORDER = Object.freeze([
  'reaction',
  'simple_reaction',
  'stroop',
  'flanker',
  'nback',
  'trail',
  'digit'
])

const BASE_CONFIG = Object.freeze({
  reaction: Object.freeze({ practiceTrials: 5, responseWindowMs: 1200, goRatio: 0.8 }),
  simple_reaction: Object.freeze({ practiceTrials: 4, minDelayMs: 1000, maxDelayMs: 2500, responseWindowMs: 1200 }),
  stroop: Object.freeze({ practiceTrials: 8, responseWindowMs: 2500 }),
  trail: Object.freeze({ practiceNodes: 4 }),
  flanker: Object.freeze({ practiceTrials: 8, responseWindowMs: 1800 }),
  nback: Object.freeze({ practiceTrials: 6, responseWindowMs: 2000, targetRatio: 1 / 3 }),
  digit: Object.freeze({ minSpan: 3, trialsPerSpan: 2, digitDurationMs: 800, gapMs: 250 })
})

const AGE_CONFIG = Object.freeze({
  child: Object.freeze({
    reaction: Object.freeze({ formalTrials: 25, blockSize: 25 }),
    simple_reaction: Object.freeze({ formalTrials: 20, blockSize: 20 }),
    stroop: Object.freeze({ formalTrials: 24, blockSize: 12, congruentRatio: 2 / 3 }),
    trail: Object.freeze({ partANodes: 12, partBPairs: 6 }),
    flanker: Object.freeze({ formalTrials: 24, blockSize: 12 }),
    nback: Object.freeze({ formalTrials: 24, blockSize: 12 }),
    digit: Object.freeze({ maxSpan: 7 })
  }),
  adult: Object.freeze({
    reaction: Object.freeze({ formalTrials: 25, blockSize: 25 }),
    simple_reaction: Object.freeze({ formalTrials: 20, blockSize: 20 }),
    stroop: Object.freeze({ formalTrials: 24, blockSize: 12, congruentRatio: 0.75 }),
    trail: Object.freeze({ partANodes: 12, partBPairs: 6 }),
    flanker: Object.freeze({ formalTrials: 24, blockSize: 12 }),
    nback: Object.freeze({ formalTrials: 24, blockSize: 12 }),
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
    schemaVersion: 5,
    protocolId: 'ultra-brief-mobile-v3',
    protocolLabel: '轻量移动筛查版',
    practicePassPercent: 75,
    maxPracticeAttempts: 3
  })
}

module.exports = {
  TASK_ORDER,
  resolveAgeGroup,
  getTaskConfig
}
