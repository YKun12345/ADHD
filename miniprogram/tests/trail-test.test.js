const assert = require('node:assert/strict')
const {
  buildTrailSequence,
  createTrailLayout,
  createRandomTrailLayout,
  buildTrailPath,
  evaluateTrailTap,
  summarizeTrailStages,
  buildTrailPayload
} = require('../utils/trail-test')

assert.equal(typeof createRandomTrailLayout, 'function', '缺少每轮随机布局接口')
assert.equal(typeof buildTrailPath, 'function', '缺少连线路径接口')

assert.deepEqual(buildTrailSequence('A', 5), ['1', '2', '3', '4', '5'])
assert.deepEqual(buildTrailSequence('B', 3), ['1', 'A', '2', 'B', '3', 'C'])
const layout = createTrailLayout(['1', '2', '3', '4'], 7)
assert.equal(layout.length, 4)
assert.equal(layout.every((item) => item.x >= 8 && item.x <= 92 && item.y >= 8 && item.y <= 92), true)
assert.deepEqual(createTrailLayout(['1', '2'], 7), createTrailLayout(['1', '2'], 7))
const randomLayoutA = createRandomTrailLayout(['1', '2', '3', '4'], () => 0.1)
const randomLayoutB = createRandomTrailLayout(['1', '2', '3', '4'], () => 0.9)
assert.notDeepEqual(randomLayoutA, randomLayoutB)

assert.deepEqual(buildTrailPath(layout, 0), [])
assert.deepEqual(buildTrailPath(layout, 1), [])
assert.deepEqual(buildTrailPath(layout, 2), [{ from: layout[0], to: layout[1] }])
assert.deepEqual(buildTrailPath(layout, 4), [
  { from: layout[0], to: layout[1] },
  { from: layout[1], to: layout[2] },
  { from: layout[2], to: layout[3] }
])

const correct = evaluateTrailTap(['1', '2'], 0, '1')
assert.equal(correct.correct, true)
assert.equal(correct.nextIndex, 1)
const wrong = evaluateTrailTap(['1', '2'], 1, '1')
assert.equal(wrong.correct, false)
assert.equal(wrong.nextIndex, 1)

const summary = summarizeTrailStages([
  { stage: 'A', elapsedMs: 12000, errors: 1, nodeCount: 12, completed: true },
  { stage: 'B', elapsedMs: 18000, errors: 2, nodeCount: 18, completed: true }
])
assert.equal(summary.elapsed_ms, 30000)
assert.equal(summary.errors, 3)
assert.equal(summary.accuracy, 91)
assert.equal(summary.completed, true)
assert.equal(buildTrailPayload(summary, [], { ageGroup: 'child' }).test_type, 'trail')

console.log('连线测试数据测试全部通过')
