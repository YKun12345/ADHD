const assert = require('node:assert/strict')

const {
  TASK_ORDER,
  resolveAgeGroup,
  getTaskConfig
} = require('../utils/cognitive-config')

assert.deepEqual(TASK_ORDER, [
  'reaction',
  'simple_reaction',
  'stroop',
  'trail',
  'flanker',
  'nback',
  'digit'
])

assert.equal(resolveAgeGroup({ patient_profile: { patient_type: 'adult' } }), 'adult')
assert.equal(resolveAgeGroup({ patient_profile: { patient_type: 'CHILD' } }), 'child')
assert.equal(resolveAgeGroup({ patient_type: 'adult' }), 'adult')
assert.equal(resolveAgeGroup(null), 'child')

assert.equal(getTaskConfig('reaction', 'child').formalTrials, 80)
assert.equal(getTaskConfig('reaction', 'adult').formalTrials, 120)
assert.equal(getTaskConfig('simple_reaction', 'child').formalTrials, 24)
assert.equal(getTaskConfig('simple_reaction', 'adult').formalTrials, 30)
assert.equal(getTaskConfig('stroop', 'adult').formalTrials, 96)
assert.equal(getTaskConfig('trail', 'adult').partANodes, 25)
assert.equal(getTaskConfig('flanker', 'child').formalTrials, 48)
assert.equal(getTaskConfig('nback', 'adult').formalTrials, 90)
assert.equal(getTaskConfig('digit', 'child').maxSpan, 8)
assert.equal(getTaskConfig('digit', 'adult').maxSpan, 9)
assert.equal(getTaskConfig('missing', 'adult'), null)

console.log('七项认知参数测试全部通过')
