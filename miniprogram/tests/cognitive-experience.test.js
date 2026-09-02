const assert = require('node:assert/strict')

const {
  getSectionState
} = require('../utils/cognitive-experience')

assert.deepEqual(getSectionState(0, 60, 20), {
  shouldBreak: false,
  completed: 0,
  total: 60,
  completedSections: 0,
  totalSections: 3,
  nextSection: 1,
  title: '准备开始第 1 小节',
  message: '保持自己的节奏，准确完成比追求速度更重要。'
})

assert.deepEqual(getSectionState(20, 60, 20), {
  shouldBreak: true,
  completed: 20,
  total: 60,
  completedSections: 1,
  totalSections: 3,
  nextSection: 2,
  title: '第 1 小节完成',
  message: '可以放松肩颈、眨眨眼，准备好后再继续。'
})

assert.equal(getSectionState(40, 60, 20).shouldBreak, true)
assert.equal(getSectionState(60, 60, 20).shouldBreak, false)
assert.equal(getSectionState(60, 60, 20).nextSection, 3)
assert.equal(getSectionState(23, 60, 20).shouldBreak, false)
assert.equal(getSectionState(-4, 0, 0).totalSections, 1)
assert.equal(getSectionState(999, 48, 24).completed, 48)

console.log('认知任务分节体验测试全部通过')
