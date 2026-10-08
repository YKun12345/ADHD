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
assert.equal(buildTrailSequence('A', 30).at(-1), '30')
assert.deepEqual(buildTrailSequence('B', 15).slice(-2), ['15', 'O'])
const layout = createTrailLayout(['1', '2', '3', '4'], 7)
assert.equal(layout.length, 4)
assert.equal(layout.every((item) => item.x >= 8 && item.x <= 92 && item.y >= 8 && item.y <= 92), true)
assert.deepEqual(createTrailLayout(['1', '2'], 7), createTrailLayout(['1', '2'], 7))
const randomLayoutA = createRandomTrailLayout(['1', '2', '3', '4'], () => 0.1)
const randomLayoutB = createRandomTrailLayout(['1', '2', '3', '4'], () => 0.9)
assert.notDeepEqual(randomLayoutA, randomLayoutB)

for (const [width, height] of [[220, 390], [260, 400], [320, 450], [540, 510]]) {
  const board = { width, height, nodeSize: 40, gap: 10 }
  const denseLayout = createTrailLayout(buildTrailSequence('A', 30), 19, board)
  assert.equal(denseLayout.length, 30)
  denseLayout.forEach((node, index) => {
    assert.equal(node.size, 40, '30节点在小屏仍需清晰可见')
    const x = node.x / 100 * width
    const y = node.y / 100 * height
    assert.ok(x >= node.size / 2 - 0.001 && x <= width - node.size / 2 + 0.001, '节点不得被左右裁切')
    assert.ok(y >= node.size / 2 - 0.001 && y <= height - node.size / 2 + 0.001, '节点不得被上下裁切')
    denseLayout.slice(index + 1).forEach((other) => {
      const distance = Math.hypot((node.x - other.x) / 100 * width, (node.y - other.y) / 100 * height)
      assert.ok(distance >= node.size + board.gap - 0.05, '节点间保留可触控间隙且互不重叠')
    })
  })
  assert.deepEqual(createRandomTrailLayout(buildTrailSequence('A', 30), () => 0.3, board), createRandomTrailLayout(buildTrailSequence('A', 30), () => 0.3, board))
}

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
const payload = buildTrailPayload(summary, [], { ageGroup: 'child' })
assert.equal(payload.test_type, 'trail')
assert.equal(payload.result_json.metrics.find((metric) => metric.label === 'A阶段用时').value, '12.0 秒')
assert.equal(payload.result_json.metrics.find((metric) => metric.label === 'B阶段用时').value, '18.0 秒')
assert.equal(payload.result_json.metrics.find((metric) => metric.label === 'A阶段错误').value, '1')
assert.equal(payload.result_json.metrics.find((metric) => metric.label === 'B阶段错误').value, '2')

console.log('连线测试数据测试全部通过')
