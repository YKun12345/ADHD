const assert = require('node:assert/strict')

const {
  TRIAL_SEQUENCE,
  buildGoNoGoTrials,
  evaluateTrial,
  summarizeTrials,
  buildCognitivePayload
} = require('../utils/gonogo-test')

const fullTrials = buildGoNoGoTrials(120)
assert.equal(fullTrials.length, 120)
assert.equal(fullTrials.filter((type) => type === 'go').length, 96)
assert.equal(fullTrials.filter((type) => type === 'nogo').length, 24)
const controlledGoNoGo = buildGoNoGoTrials(20, () => 0)
assert.notDeepEqual(
  controlledGoNoGo,
  ['go', 'go', 'go', 'nogo', 'go', 'go', 'go', 'go', 'nogo', 'go', 'go', 'go', 'go', 'nogo', 'go', 'go', 'go', 'go', 'nogo', 'go']
)
assert.equal(controlledGoNoGo.filter((type) => type === 'nogo').length, 4)

assert.equal(TRIAL_SEQUENCE.length, 10)
assert.equal(TRIAL_SEQUENCE.filter((type) => type === 'go').length, 6)
assert.equal(TRIAL_SEQUENCE.filter((type) => type === 'nogo').length, 4)
assert.equal(
  TRIAL_SEQUENCE.every((type) => type === 'go' || type === 'nogo'),
  true
)

assert.deepEqual(evaluateTrial({
  type: 'go',
  action: 'tap',
  reactionTimeMs: 327.8
}), {
  type: 'go',
  action: 'tap',
  correct: true,
  reactionTimeMs: 328,
  errorType: null
})

assert.deepEqual(evaluateTrial({ type: 'go', action: 'timeout' }), {
  type: 'go',
  action: 'timeout',
  correct: false,
  reactionTimeMs: null,
  errorType: 'omission'
})

assert.deepEqual(evaluateTrial({ type: 'nogo', action: 'timeout' }), {
  type: 'nogo',
  action: 'timeout',
  correct: true,
  reactionTimeMs: null,
  errorType: null
})

assert.deepEqual(evaluateTrial({ type: 'nogo', action: 'tap' }), {
  type: 'nogo',
  action: 'tap',
  correct: false,
  reactionTimeMs: null,
  errorType: 'commission'
})

assert.deepEqual(evaluateTrial({ type: 'go', action: 'false_start' }), {
  type: 'go',
  action: 'false_start',
  correct: false,
  reactionTimeMs: null,
  errorType: 'false_start'
})

assert.equal(evaluateTrial({ type: 'unknown', action: 'tap' }), null)
assert.equal(evaluateTrial({ type: 'go', action: 'unknown' }), null)

const records = [
  evaluateTrial({ type: 'go', action: 'tap', reactionTimeMs: 300 }),
  evaluateTrial({ type: 'go', action: 'tap', reactionTimeMs: 400 }),
  evaluateTrial({ type: 'nogo', action: 'timeout' }),
  evaluateTrial({ type: 'go', action: 'timeout' }),
  evaluateTrial({ type: 'nogo', action: 'tap' }),
  evaluateTrial({ type: 'go', action: 'false_start' }),
  evaluateTrial({ type: 'go', action: 'tap', reactionTimeMs: 500 }),
  evaluateTrial({ type: 'nogo', action: 'timeout' }),
  evaluateTrial({ type: 'go', action: 'tap', reactionTimeMs: -10 }),
  evaluateTrial({ type: 'nogo', action: 'timeout' })
]

assert.deepEqual(summarizeTrials(records), {
  total_trials: 10,
  correct_trials: 7,
  accuracy: 70,
  go_accuracy: 67,
  nogo_accuracy: 75,
  average_reaction_time_ms: 300,
  fastest_reaction_time_ms: 0,
  commission_errors: 1,
  omission_errors: 1,
  false_starts: 1
})

assert.deepEqual(summarizeTrials([]), {
  total_trials: 0,
  correct_trials: 0,
  accuracy: 0,
  go_accuracy: 0,
  nogo_accuracy: 0,
  average_reaction_time_ms: 0,
  fastest_reaction_time_ms: 0,
  commission_errors: 0,
  omission_errors: 0,
  false_starts: 0
})

assert.equal(buildCognitivePayload(records.slice(0, 9)), null)
assert.deepEqual(
  buildCognitivePayload(records, '2026-08-21T02:00:00.000Z'),
  {
    test_type: 'reaction',
    result_json: {
      test_name: '反应抑制任务',
      status_text: '已完成测试',
      summary: '反应抑制任务已完成。本次结果记录反应速度、注意保持和抑制控制的客观表现。',
      metrics: [
        { label: '正确率', value: '70%' },
        { label: '平均反应时', value: '300 ms' },
        { label: '冲动错误', value: '1' },
        { label: '提前误触', value: '1' }
      ],
      test_variant: 'go_nogo',
      raw_result: summarizeTrials(records),
      finished_at: '2026-08-21T02:00:00.000Z'
    }
  }
)

const fullPayload = buildCognitivePayload(
  fullTrials.map((type) => evaluateTrial({ type, action: type === 'go' ? 'tap' : 'timeout', reactionTimeMs: 350 })),
  '2026-08-29T02:00:00.000Z',
  { ageGroup: 'adult', mode: 'battery' }
)
assert.equal(fullPayload.result_json.schema_version, 2)
assert.equal(fullPayload.result_json.age_group, 'adult')
assert.equal(fullPayload.result_json.trials.length, 120)

console.log('Go/No-Go 测试数据测试全部通过')
