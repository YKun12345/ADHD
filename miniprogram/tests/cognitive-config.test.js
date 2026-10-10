const assert = require('node:assert/strict')

const {
  TASK_ORDER,
  resolveAgeGroup,
  getTaskConfig
} = require('../utils/cognitive-config')

assert.deepEqual(TASK_ORDER, [
  'reaction',
  'stroop',
  'flanker',
  'nback',
  'trail',
  'digit'
])

assert.equal(resolveAgeGroup({ patient_profile: { patient_type: 'adult' } }), 'adult')
assert.equal(resolveAgeGroup({ patient_profile: { patient_type: 'CHILD' } }), 'child')
assert.equal(resolveAgeGroup({ patient_type: 'adult' }), 'adult')
assert.equal(resolveAgeGroup(null), 'child')

assert.equal(getTaskConfig('reaction', 'child').formalTrials, 25)
assert.equal(getTaskConfig('reaction', 'adult').formalTrials, 25)
assert.equal(getTaskConfig('reaction', 'adult').blockSize, 25)
assert.equal(getTaskConfig('reaction', 'adult').practiceTrials, 5)
assert.equal(getTaskConfig('stroop', 'child').formalTrials, 24)
assert.equal(getTaskConfig('stroop', 'adult').formalTrials, 24)
assert.equal(getTaskConfig('stroop', 'adult').blockSize, 24)
assert.equal(getTaskConfig('stroop', 'adult').practiceTrials, 8)
assert.equal(getTaskConfig('trail', 'adult').partANodes, 30)
assert.equal(getTaskConfig('trail', 'adult').partBPairs, 15)
assert.equal(getTaskConfig('trail', 'adult').practiceNodes, 4)
assert.equal(getTaskConfig('flanker', 'child').formalTrials, 24)
assert.equal(getTaskConfig('flanker', 'adult').formalTrials, 24)
assert.equal(getTaskConfig('flanker', 'adult').blockSize, 24)
assert.equal(getTaskConfig('flanker', 'adult').practiceTrials, 8)
assert.equal(getTaskConfig('nback', 'adult').formalTrials, 24)
assert.equal(getTaskConfig('nback', 'adult').blockSize, 24)
assert.equal(getTaskConfig('nback', 'adult').practiceTrials, 6)
assert.equal(getTaskConfig('digit', 'child').maxSpan, 7)
assert.equal(getTaskConfig('digit', 'adult').maxSpan, 8)
assert.equal(getTaskConfig('missing', 'adult'), null)

for (const ageGroup of ['child', 'adult']) {
  for (const taskId of ['reaction', 'stroop', 'flanker', 'nback']) {
    const config = getTaskConfig(taskId, ageGroup)
    assert.equal(config.formalTrials <= 60, true, `${ageGroup}/${taskId} 不得超过 60 个正式试次`)
    assert.equal(config.formalTrials % config.blockSize, 0, `${ageGroup}/${taskId} 小节必须完整分割`)
    assert.equal(config.protocolId, 'continuous-mobile-v4')
    assert.equal(config.protocolLabel, '连续移动筛查版')
    assert.equal(config.schemaVersion, 6)
  }
}

console.log('六项认知参数测试全部通过')
