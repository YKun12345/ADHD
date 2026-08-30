const assert = require('node:assert/strict')

const {
  LATEST_RESULTS_KEY,
  mergeLatestResult,
  normalizeLatestResults,
  buildCognitiveSummary
} = require('../utils/cognitive-results')

const reactionPayload = {
  test_type: 'reaction',
  result_json: {
    test_name: 'Go/No-Go 测试',
    raw_result: {
      accuracy: 80,
      average_reaction_time_ms: 320
    },
    finished_at: '2026-08-21T02:00:00.000Z'
  }
}
const stroopPayload = {
  test_type: 'stroop',
  result_json: {
    test_name: 'Stroop 测试',
    raw_result: {
      accuracy: 75,
      average_reaction_time_ms: 450
    },
    finished_at: '2026-08-21T03:00:00.000Z'
  }
}

function genericPayload(type, accuracy = 70) {
  return {
    test_type: type,
    result_json: {
      test_name: type,
      raw_result: { accuracy },
      finished_at: '2026-08-29T03:00:00.000Z'
    }
  }
}

assert.equal(LATEST_RESULTS_KEY, 'cognitive_latest_results')
assert.deepEqual(normalizeLatestResults(null), {})
assert.deepEqual(normalizeLatestResults({ reaction: {} }), {})
assert.deepEqual(mergeLatestResult({}, { test_type: 'unknown' }), {})

const reactionState = mergeLatestResult({}, reactionPayload)
assert.deepEqual(reactionState, {
  reaction: reactionPayload
})
assert.deepEqual(
  mergeLatestResult(reactionState, stroopPayload),
  {
    reaction: reactionPayload,
    stroop: stroopPayload
  }
)

const emptySummary = buildCognitiveSummary({})
assert.equal(emptySummary.completedCount, 0)
assert.equal(emptySummary.totalCount, 7)
assert.equal(emptySummary.progressPercent, 0)
assert.equal(emptySummary.allCompleted, false)
assert.equal(emptySummary.cards.every((card) => !card.completed), true)
assert.equal(emptySummary.cards[0].url, '/pages/cognitive/index')
assert.equal(emptySummary.cards[1].url, '/pages/simple-reaction/index')
assert.equal(emptySummary.cards[2].url, '/pages/stroop/index')
assert.equal(emptySummary.cards[3].url, '/pages/trail/index')
assert.equal(emptySummary.cards[4].url, '/pages/flanker/index')
assert.equal(emptySummary.cards[5].url, '/pages/nback/index')
assert.equal(emptySummary.cards[6].url, '/pages/digit-span/index')

const partialSummary = buildCognitiveSummary(reactionState)
assert.equal(partialSummary.completedCount, 1)
assert.equal(partialSummary.progressPercent, 14)
assert.equal(partialSummary.cards[0].completed, true)
assert.equal(partialSummary.cards[0].primaryMetric, '正确率 80%')
assert.equal(partialSummary.cards[1].statusLabel, '开始测试')

const completeSummary = buildCognitiveSummary({
  reaction: reactionPayload,
  simple_reaction: genericPayload('simple_reaction', 82),
  stroop: stroopPayload,
  trail: genericPayload('trail', 84),
  flanker: genericPayload('flanker', 86),
  nback: genericPayload('nback', 78),
  digit: genericPayload('digit', 76),
  ignored: { value: true }
})
assert.equal(completeSummary.completedCount, 7)
assert.equal(completeSummary.progressPercent, 100)
assert.equal(completeSummary.allCompleted, true)
assert.equal(completeSummary.cards[2].primaryMetric, '正确率 75%')
assert.equal(
  completeSummary.summaryText,
  '七项认知任务均已完成，可继续进入每日追踪。'
)

console.log('认知结果汇总测试全部通过')
