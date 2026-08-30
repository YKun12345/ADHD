const assert = require('node:assert/strict')

const {
  createCanvasMetrics,
  scalePoints,
  measureTextWidths,
  createCartesianCanvasLayout,
  createRadarCanvasLayout,
  clampRadarLabelX
} = require('../utils/canvas-scale')

assert.deepEqual(
  createCanvasMetrics(330, 180, 3),
  {
    cssWidth: 330,
    cssHeight: 180,
    pixelWidth: 990,
    pixelHeight: 540,
    dpr: 3
  },
  'canvas metrics should separate CSS and physical pixel sizes'
)

assert.deepEqual(
  scalePoints([
    { x: 10, y: 12, label: 'A' },
    null,
    { x: 20, y: 24 }
  ], 2),
  [
    { x: 20, y: 24, label: 'A' },
    null,
    { x: 40, y: 48 }
  ],
  'scalePoints should preserve gaps and point metadata'
)

for (const args of [
  [0, 180, 3],
  [330, -1, 3],
  [330, 180, 0],
  [Number.NaN, 180, 3],
  [330, Number.POSITIVE_INFINITY, 3]
]) {
  assert.throws(
    () => createCanvasMetrics(...args),
    RangeError,
    'invalid dimensions and DPR should be rejected'
  )
}

assert.throws(() => scalePoints([], 0), RangeError)
assert.throws(() => scalePoints('not-an-array', 2), TypeError)

assert.deepEqual(
  measureTextWidths(['1', '720', '1440'], (text) => ({ width: text.length * 6 })),
  [6, 18, 24],
  'canvas labels should use measured text widths'
)
assert.deepEqual(
  measureTextWidths(['1', '720', '1440']),
  [7, 21, 28],
  'canvas labels should use a stable per-character fallback'
)

const narrowChartLayout = createCartesianCanvasLayout(
  320,
  220,
  measureTextWidths(['0', '720', '1440'], (text) => ({ width: text.length * 7 }))
)
assert.equal(narrowChartLayout.left >= 38, true, 'left padding should fit 1440 plus a safety gap')
assert.equal(narrowChartLayout.right >= 16, true, 'right padding should protect the final point')
assert.equal(narrowChartLayout.plotWidth > 220, true, '320px canvas should retain a useful plot area')

const radarLayout = createRadarCanvasLayout(320, 260, [70, 62, 70, 62, 70])
assert.equal(radarLayout.radius > 0, true)
assert.equal(radarLayout.centerX, 160)
assert.equal(radarLayout.centerY, 130)
for (const [x, width, alignment] of [
  [-20, 70, 'left'],
  [340, 70, 'right'],
  [160, 70, 'center']
]) {
  const safeX = clampRadarLabelX(x, width, alignment, 320, 8)
  const left = alignment === 'left' ? safeX : alignment === 'right' ? safeX - width : safeX - (width / 2)
  const right = left + width
  assert.equal(left >= 8, true, `${alignment} label should stay inside the left edge`)
  assert.equal(right <= 312, true, `${alignment} label should stay inside the right edge`)
}

console.log('canvas scale helper tests passed')
