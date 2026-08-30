const assert = require('node:assert/strict')

const {
  BATTERY_STATE_KEY,
  createBatteryState,
  normalizeBatteryState,
  completeBatteryTask,
  nextBatteryTask
} = require('../utils/cognitive-battery')

assert.equal(BATTERY_STATE_KEY, 'cognitive_battery_state')

const initial = createBatteryState('patient-7', 'adult', '2026-08-29T01:00:00.000Z')
assert.equal(initial.patientKey, 'patient-7')
assert.equal(initial.ageGroup, 'adult')
assert.equal(initial.mode, 'battery')
assert.deepEqual(initial.completedTaskIds, [])
assert.equal(nextBatteryTask(initial), 'reaction')

const afterReaction = completeBatteryTask(initial, 'reaction', '2026-08-29T01:05:00.000Z')
assert.deepEqual(afterReaction.completedTaskIds, ['reaction'])
assert.equal(nextBatteryTask(afterReaction), 'simple_reaction')
assert.deepEqual(
  completeBatteryTask(afterReaction, 'reaction').completedTaskIds,
  ['reaction']
)

let completed = initial
for (const taskId of ['reaction', 'simple_reaction', 'stroop', 'trail', 'flanker', 'nback', 'digit']) {
  completed = completeBatteryTask(completed, taskId)
}
assert.equal(nextBatteryTask(completed), '')
assert.equal(completed.completed, true)

assert.equal(normalizeBatteryState(initial, 'another-patient'), null)
assert.equal(normalizeBatteryState({ bad: true }, 'patient-7'), null)
assert.equal(normalizeBatteryState(afterReaction, 'patient-7').completedTaskIds.length, 1)

console.log('完整认知评估状态测试全部通过')
