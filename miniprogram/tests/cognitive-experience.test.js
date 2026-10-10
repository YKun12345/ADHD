const assert = require('node:assert/strict')
const { getSectionState } = require('../utils/cognitive-experience')

// Historic block sizes must no longer introduce a formal-test rest.
for (const [total, oldBlockSize] of [[24, 12], [60, 20], [48, 24]]) {
  for (let completed = 0; completed <= total; completed++) {
    const state = getSectionState(completed, total, oldBlockSize)
    assert.equal(state.shouldBreak, false)
    assert.equal(state.totalSections, 1)
    assert.equal(state.nextSection, 1)
    assert.equal(state.completedSections, completed === total ? 1 : 0)
    assert.equal(state.completed, completed)
    assert.equal(state.title.includes('小节'), false)
  }
}
assert.equal(getSectionState(0, 24, 12).title, '准备开始测试')
assert.equal(getSectionState(12, 24, 12).title, '测试进行中')
assert.equal(getSectionState(24, 24, 12).title, '测试已完成')
assert.equal(getSectionState(-4, 0, 0).totalSections, 1)
assert.equal(getSectionState(999, 48, 24).completed, 48)
console.log('认知任务连续进度与历史分节参数兼容测试全部通过')
