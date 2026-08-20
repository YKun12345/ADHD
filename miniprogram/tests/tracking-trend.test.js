const assert = require('node:assert/strict')
const { buildTrackingTrendModel, createChartPoints } = require('../utils/tracking-trend')
const logs = [
  { day_index: 1, mood_tag: '4', attention_rating: 3, focus_minutes: 60 },
  { day_index: 3, mood_tag: '2', attention_rating: 5, focus_minutes: 90, demo: true },
  { day_index: 20, mood_tag: '5', attention_rating: 5, focus_minutes: 200 }
]
const model = buildTrackingTrendModel(logs)
assert.equal(model.completedCount, 2)
assert.equal(model.demoMode, true)
assert.equal(model.series.mood.values.length, 14)
assert.deepEqual(model.series.mood.values.slice(0, 3), [4, null, 2])
assert.equal(model.series.mood.average, 3)
assert.equal(model.series.attention.average, 4)
assert.equal(model.series.focus.average, 75)
assert.equal(model.series.focus.maxValue, 90)
assert.equal(buildTrackingTrendModel([]).hasData, false)

const points = createChartPoints([1, null, 5], 300, 200, 20, 5)
assert.deepEqual(points, [
  { day: 1, value: 1, x: 20, y: 180 },
  null,
  { day: 3, value: 5, x: 60, y: 20 }
])
console.log('追踪趋势数据测试全部通过')
