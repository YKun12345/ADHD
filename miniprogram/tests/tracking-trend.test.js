const assert = require('node:assert/strict')
const { buildTrackingTrendModel, createChartPoints, createDayAxisTicks } = require('../utils/tracking-trend')
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

const incompleteLogs = [
  { day_index: 1, mood_tag: null, attention_rating: '', focus_minutes: null },
  { day_index: 2, mood_tag: ' ', attention_rating: undefined, focus_minutes: '' },
  { day_index: 3, mood_tag: false, attention_rating: true, focus_minutes: false },
  { day_index: 4, mood_tag: '4', attention_rating: 3, focus_minutes: 0 },
  { day_index: 5, mood_tag: '2', attention_rating: 5, focus_minutes: 60 }
]
const originalLogs = JSON.stringify(incompleteLogs)
const incomplete = buildTrackingTrendModel(incompleteLogs)
assert.deepEqual(incomplete.series.mood.values.slice(0, 5), [null, null, null, 4, 2], 'missing ratings must remain gaps rather than becoming zero')
assert.deepEqual(incomplete.series.attention.values.slice(0, 5), [null, null, null, 3, 5])
assert.deepEqual(incomplete.series.focus.values.slice(0, 5), [null, null, null, 0, 60], 'an explicitly recorded zero minutes remains valid')
assert.equal(incomplete.series.mood.average, 3)
assert.equal(incomplete.series.attention.average, 4)
assert.equal(incomplete.series.focus.average, 30, 'only recorded values contribute to the rounded mean')
assert.equal(JSON.stringify(incompleteLogs), originalLogs, 'building the chart must not change the source logs')

const points = createChartPoints([1, null, 5], 300, 200, 20, 5)
assert.deepEqual(points, [
  { day: 1, value: 1, x: 20, y: 180 },
  null,
  { day: 3, value: 5, x: 60, y: 20 }
])

const layout = { left: 37, top: 18, plotWidth: 271, plotHeight: 170 }
const dayTicks = createDayAxisTicks(layout)
const fullPoints = createChartPoints(Array(14).fill(3), layout.plotWidth, layout.plotHeight, 0, 5)
assert.deepEqual(dayTicks.map((tick) => tick.day), [1, 7, 14])
for (const tick of dayTicks) {
  assert.equal(tick.x, layout.left + fullPoints[tick.day - 1].x, `day ${tick.day} label must share its data point's exact x coordinate`)
}
assert.equal(dayTicks[1].x < layout.left + layout.plotWidth / 2, true, 'day 7 is index 6 of 13 intervals, not the visual midpoint')
console.log('追踪趋势数据测试全部通过')
