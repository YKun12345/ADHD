const assert = require('node:assert/strict')

const {
  COLORS,
  STROOP_TRIALS,
  buildStroopTrials,
  evaluateStroopChoice,
  summarizeStroopTrials,
  buildStroopPayload
} = require('../utils/stroop-test')

const fullStroop = buildStroopTrials(96, 0.75)
assert.equal(fullStroop.length, 96)
assert.equal(fullStroop.filter((trial) => trial.wordKey === trial.colorKey).length, 72)
assert.equal(fullStroop.filter((trial) => trial.wordKey !== trial.colorKey).length, 24)
assert.deepEqual(
  COLORS.map((color) => fullStroop.filter((trial) => trial.colorKey === color.key).length),
  [24, 24, 24, 24]
)
const controlledStroop = buildStroopTrials(32, 0.75, () => 0)
assert.equal(controlledStroop.slice(0, 24).some((trial) => trial.wordKey !== trial.colorKey), true)
assert.equal(controlledStroop.filter((trial) => trial.wordKey === trial.colorKey).length, 24)

assert.deepEqual(
  COLORS.map((color) => color.key),
  ['red', 'green', 'blue', 'yellow']
)

const fullRecords = fullStroop.map((trial) => evaluateStroopChoice(trial, trial.colorKey, 500))
const fullPayload = buildStroopPayload(fullRecords, '2026-08-29T03:00:00.000Z', { ageGroup: 'adult', mode: 'battery' })
assert.equal(fullPayload.result_json.schema_version, 2)
assert.equal(fullPayload.result_json.age_group, 'adult')
assert.equal(fullPayload.result_json.trials.length, 96)
assert.equal(STROOP_TRIALS.length, 8)
assert.equal(
  STROOP_TRIALS.every((trial) => (
    COLORS.some((color) => color.key === trial.wordKey) &&
    COLORS.some((color) => color.key === trial.colorKey)
  )),
  true
)
assert.deepEqual(
  COLORS.map((color) => (
    STROOP_TRIALS.filter((trial) => trial.colorKey === color.key).length
  )),
  [2, 2, 2, 2]
)

assert.deepEqual(
  evaluateStroopChoice(STROOP_TRIALS[0], 'red', 246.7),
  {
    wordKey: 'red',
    colorKey: 'red',
    selectedKey: 'red',
    congruent: true,
    correct: true,
    reactionTimeMs: 247
  }
)
assert.equal(evaluateStroopChoice(STROOP_TRIALS[0], 'purple', 100), null)
assert.equal(evaluateStroopChoice(null, 'red', 100), null)
assert.deepEqual(evaluateStroopChoice(STROOP_TRIALS[0], null, null), {
  wordKey: 'red',
  colorKey: 'red',
  selectedKey: '',
  congruent: true,
  correct: false,
  outcome: 'omission',
  reactionTimeMs: null
})

const records = STROOP_TRIALS.map((trial, index) => (
  evaluateStroopChoice(
    trial,
    index === 0 || index === 1
      ? COLORS.find((color) => color.key !== trial.colorKey).key
      : trial.colorKey,
    (index + 1) * 100
  )
))

assert.deepEqual(summarizeStroopTrials(records), {
  total_trials: 8,
  correct: 6,
  wrong: 2,
  omissions: 0,
  accuracy: 75,
  average_reaction_time_ms: 450,
  median_reaction_time_ms: 550,
  fastest_reaction_time_ms: 100,
  congruent_accuracy: 67,
  incongruent_accuracy: 80,
  congruent_median_reaction_time_ms: 500,
  incongruent_median_reaction_time_ms: 550,
  interference_effect_ms: 50
})

assert.deepEqual(summarizeStroopTrials([]), {
  total_trials: 0,
  correct: 0,
  wrong: 0,
  omissions: 0,
  accuracy: 0,
  average_reaction_time_ms: 0,
  median_reaction_time_ms: 0,
  fastest_reaction_time_ms: 0,
  congruent_accuracy: 0,
  incongruent_accuracy: 0,
  congruent_median_reaction_time_ms: 0,
  incongruent_median_reaction_time_ms: 0,
  interference_effect_ms: 0
})

assert.equal(buildStroopPayload(records.slice(0, 7)), null)
assert.deepEqual(
  buildStroopPayload(records, '2026-08-21T03:00:00.000Z'),
  {
    test_type: 'stroop',
    result_json: {
      test_name: 'Stroop 测试',
      status_text: '已完成测试',
      summary: 'Stroop 测试已完成。本次结果记录冲突信息下的颜色选择正确率和反应速度。',
      metrics: [
        { label: '正确率', value: '75%' },
        { label: '平均反应时', value: '450 ms' },
        { label: '正确次数', value: '6' },
        { label: '错误次数', value: '2' }
      ],
      raw_result: summarizeStroopTrials(records),
      finished_at: '2026-08-21T03:00:00.000Z'
    }
  }
)

console.log('Stroop 测试数据测试全部通过')
