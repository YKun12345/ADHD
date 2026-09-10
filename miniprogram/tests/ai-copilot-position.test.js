const assert = require('node:assert/strict')

const {
  createViewportBounds,
  clampPosition,
  movePosition,
  snapPosition,
  serializePosition,
  restorePosition,
  buildPositionStorageKey
} = require('../utils/ai-copilot-position')

const phone = createViewportBounds({
  windowWidth: 375,
  windowHeight: 812,
  statusBarHeight: 44,
  safeArea: { top: 44, bottom: 778 }
})

assert.deepEqual(phone, {
  minX: 12,
  maxX: 311,
  minY: 96,
  maxY: 710,
  width: 375,
  height: 812
})

assert.deepEqual(restorePosition(null, phone), { x: 311, y: 710 })
assert.deepEqual(clampPosition({ x: -30, y: 900 }, phone), { x: 12, y: 710 })
assert.deepEqual(
  movePosition({ x: 100, y: 200 }, { x: 45, y: -70 }, phone),
  { x: 145, y: 130 }
)
assert.deepEqual(snapPosition({ x: 80, y: 300 }, phone), { x: 12, y: 300 })
assert.deepEqual(snapPosition({ x: 250, y: 300 }, phone), { x: 311, y: 300 })

const saved = serializePosition({ x: 12, y: 403 }, phone)
assert.deepEqual(saved, { version: 1, side: 'left', yRatio: 0.5 })

const tablet = createViewportBounds({
  windowWidth: 768,
  windowHeight: 1024,
  statusBarHeight: 24,
  safeArea: { top: 24, bottom: 1000 }
})
assert.deepEqual(restorePosition(saved, tablet), { x: 12, y: 504 })
assert.deepEqual(restorePosition({ version: 1, side: 'bad', yRatio: 7 }, phone), { x: 311, y: 710 })

assert.equal(buildPositionStorageKey({ id: 7, role: 'patient' }), 'ai_copilot_position_v1:patient:7')
assert.equal(buildPositionStorageKey({ id: 3, role: 'researcher' }), 'ai_copilot_position_v1:researcher:3')
assert.equal(buildPositionStorageKey({}), 'ai_copilot_position_v1:patient:anonymous')

console.log('AI Copilot 浮动位置测试全部通过')
