const assert = require('node:assert/strict')

const {
  SCALE_LATEST_RESULT_KEY,
  isReportableScaleResult,
  buildLocalReport,
  mergeReport,
  createRadarGeometry
} = require('../utils/report-data')

function scaleResult(scaleType = 'ASRS') {
  const adultRadar = {
    attention_control: 12,
    organization: 10,
    task_activation: 11,
    hyperactivity: 8,
    impulsivity: 9
  }
  const childRadar = {
    attention_control: 13,
    organization: 9,
    hyperactivity: 10,
    impulsivity: 7,
    emotional_regulation: 8
  }

  return {
    id: 8,
    scale_type: scaleType,
    respondent_type: scaleType === 'ASRS' ? 'self' : 'parent',
    total_score: scaleType === 'ASRS' ? 28 : 31,
    risk_level: 'medium',
    radar_scores: scaleType === 'ASRS' ? adultRadar : childRadar,
    sub_scores: {},
    summary: '量表摘要',
    recommendations: ['继续完成追踪'],
    created_at: '2026-08-21T08:00:00.000Z'
  }
}

function cognitivePayload(type, accuracy, reactionTime) {
  return {
    test_type: type,
    result_json: {
      raw_result: {
        accuracy,
        average_reaction_time_ms: reactionTime
      },
      finished_at: '2026-08-21T08:20:00.000Z'
    }
  }
}

function cognitiveRawPayload(type, rawResult) {
  return {
    test_type: type,
    result_json: {
      raw_result: rawResult,
      quality: { valid: true, flags: [] },
      finished_at: '2026-08-29T08:20:00.000Z'
    }
  }
}

const user = {
  full_name: '综合报告患者',
  patient_profile: {
    patient_type: 'adult'
  }
}

const localReport = buildLocalReport({
  user,
  scaleResult: scaleResult(),
  cognitiveResults: {
    reaction: cognitivePayload('reaction', 80, 420),
    simple_reaction: cognitiveRawPayload('simple_reaction', { accuracy: 90, median_reaction_time_ms: 310 }),
    stroop: cognitiveRawPayload('stroop', { accuracy: 75, median_reaction_time_ms: 640, interference_effect_ms: 95 }),
    trail: cognitiveRawPayload('trail', { accuracy: 92, elapsed_ms: 28000, errors: 2 }),
    flanker: cognitivePayload('flanker', 83, 510),
    nback: cognitiveRawPayload('nback', { accuracy: 78, d_prime: 1.42 }),
    digit: cognitiveRawPayload('digit', { accuracy: 72, forward_max_span: 7, backward_max_span: 5 })
  },
  trackingLogs: [
    {
      day_index: 1,
      mood_tag: '4',
      attention_rating: 3,
      focus_minutes: 60
    },
    {
      day_index: 3,
      mood_tag: '2',
      attention_rating: 5,
      focus_minutes: 90
    }
  ]
})

assert.equal(SCALE_LATEST_RESULT_KEY, 'scale_latest_result')
assert.equal(isReportableScaleResult({}), false)
assert.equal(isReportableScaleResult(scaleResult()), true)
assert.equal(localReport.patientName, '综合报告患者')
assert.equal(localReport.patientType, 'adult')
assert.equal(localReport.patientTypeLabel, '成人患者')
assert.equal(localReport.source, 'local')
assert.equal(localReport.sourceLabel, '本地结果')
assert.equal(localReport.hasAnyData, true)
assert.equal(localReport.scale.hasData, true)
assert.equal(localReport.scale.hasRadar, true)
assert.equal(localReport.scale.radarAxes.length, 5)
assert.deepEqual(
  localReport.scale.radarAxes.map((axis) => axis.label),
  ['注意控制', '组织管理', '任务启动', '多动表现', '冲动控制']
)
assert.equal(localReport.scale.riskLabel, '中等风险')
assert.equal(localReport.scale.respondentLabel, '本人填写')
assert.equal(localReport.cognitive.completedCount, 7)
assert.equal(localReport.cognitive.totalCount, 7)
assert.equal(localReport.cognitive.cards[0].primaryMetric, '正确率 80%')
assert.equal(localReport.cognitive.cards[1].primaryMetric, '中位反应时 310 ms')
assert.equal(localReport.cognitive.cards[2].primaryMetric, '中位反应时 640 ms')
assert.equal(localReport.cognitive.cards[2].secondaryMetric, '干扰效应 95 ms')
assert.equal(localReport.cognitive.cards[3].primaryMetric, '总用时 28.0 秒')
assert.equal(localReport.cognitive.cards[6].primaryMetric, '顺背 7 · 倒背 5')
assert.equal(localReport.tracking.completedCount, 2)
assert.equal(localReport.tracking.averageMood, 3)
assert.equal(localReport.tracking.averageAttention, 4)
assert.equal(localReport.tracking.averageFocusMinutes, 75)
assert.deepEqual(
  localReport.tracking.attentionValues.slice(0, 3),
  [3, null, 5]
)
assert.equal(localReport.coverage.completedCount, 3)
assert.equal(localReport.coverage.totalCount, 3)
assert.equal(localReport.coverage.percent, 100)

const childReport = buildLocalReport({
  user: {
    full_name: '儿童患者',
    patient_profile: { patient_type: 'CHILD' }
  },
  scaleResult: scaleResult('SNAP_IV')
})
assert.equal(childReport.patientType, 'child')
assert.equal(childReport.patientTypeLabel, '儿童患者')
assert.deepEqual(
  childReport.scale.radarAxes.map((axis) => axis.label),
  ['注意控制', '组织管理', '多动表现', '冲动控制', '情绪调节']
)
assert.equal(childReport.scale.respondentLabel, '家长填写')

const incompleteRadar = scaleResult()
delete incompleteRadar.radar_scores.organization
const incompleteReport = buildLocalReport({ user, scaleResult: incompleteRadar })
assert.equal(incompleteReport.scale.hasData, true)
assert.equal(incompleteReport.scale.hasRadar, false)
assert.deepEqual(incompleteReport.scale.radarAxes, [])
assert.equal(isReportableScaleResult(incompleteRadar), false)

const clampedRadar = scaleResult()
clampedRadar.radar_scores.attention_control = 99
clampedRadar.radar_scores.organization = -5
const clampedReport = buildLocalReport({ user, scaleResult: clampedRadar })
assert.deepEqual(
  clampedReport.scale.radarAxes.slice(0, 2).map((axis) => axis.value),
  [20, 0]
)

for (const invalidValue of [NaN, Infinity, -Infinity, 'not-a-number']) {
  const invalid = scaleResult()
  invalid.radar_scores.attention_control = invalidValue
  assert.equal(
    buildLocalReport({ user, scaleResult: invalid }).scale.hasRadar,
    false
  )
}

assert.equal(
  buildLocalReport({
    user,
    scaleResult: {
      ...scaleResult(),
      risk_level: 'unknown'
    }
  }).scale.hasData,
  false
)

const emptyReport = buildLocalReport({
  user: null,
  scaleResult: null,
  cognitiveResults: null,
  trackingLogs: null
})
assert.equal(emptyReport.patientName, '患者')
assert.equal(emptyReport.hasAnyData, false)
assert.equal(emptyReport.coverage.percent, 0)
assert.equal(emptyReport.cognitive.completedCount, 0)
assert.equal(emptyReport.tracking.completedCount, 0)

const demoReport = buildLocalReport({
  user,
  trackingLogs: [{
    day_index: 1,
    mood_tag: '3',
    attention_rating: 4,
    focus_minutes: 45,
    demo: true,
    sync_status: 'local_demo'
  }]
})
assert.equal(demoReport.tracking.demoMode, true)
assert.equal(demoReport.tracking.sourceLabel, '本地演示')

const localOnlyCognitive = buildLocalReport({
  user,
  cognitiveResults: {
    reaction: cognitivePayload('reaction', 88, 380)
  },
  trackingLogs: [{
    day_index: 2,
    mood_tag: '4',
    attention_rating: 5,
    focus_minutes: 70
  }]
})
const serverScale = scaleResult()
serverScale.total_score = 35
const merged = mergeReport(localOnlyCognitive, {
  patient_name: '服务器姓名',
  patient_type: 'adult',
  latest_scale: serverScale,
  cognitive_profile: {
    summary: '服务器认知摘要',
    latest_tests: [{
      test_type: 'stroop',
      test_name: '服务器 Stroop',
      status_text: '已完成',
      key_metric: '正确率 60%',
      finished_at: '2026-08-20T08:00:00.000Z'
    }]
  },
  tracking_summary: {
    total_days: 14,
    completed_days: [1, 2, 3],
    completed_count: 3,
    current_day: 4,
    average_mood: 4,
    average_focus_minutes: 55
  }
})
assert.equal(merged.patientName, '综合报告患者')
assert.equal(merged.source, 'server')
assert.equal(merged.sourceLabel, '已同步')
assert.equal(merged.scale.totalScore, 35)
assert.equal(merged.scale.source, 'server')
assert.equal(merged.cognitive.cards[0].primaryMetric, '正确率 88%')
assert.equal(merged.cognitive.source, 'mixed')
assert.equal(merged.cognitive.completedCount, 2)
assert.equal(merged.tracking.completedCount, 1)
assert.equal(merged.tracking.source, 'local')

const serverFallback = mergeReport(emptyReport, {
  patient_name: '服务器患者',
  patient_type: 'child',
  cognitive_profile: {
    summary: '服务器认知摘要',
    latest_tests: [{
      test_type: 'stroop',
      test_name: 'Stroop',
      status_text: '已记录',
      key_metric: '正确率 70%',
      finished_at: '2026-08-21T09:00:00.000Z'
    }]
  },
  tracking_summary: {
    total_days: 14,
    completed_days: [1, 2],
    completed_count: 2,
    current_day: 3,
    average_mood: 3.5,
    average_focus_minutes: 50
  }
})
assert.equal(serverFallback.patientName, '服务器患者')
assert.equal(serverFallback.patientTypeLabel, '儿童患者')
assert.equal(serverFallback.cognitive.completedCount, 1)
assert.equal(serverFallback.tracking.completedCount, 2)
assert.equal(serverFallback.sourceLabel, '已同步')

const invalidServerScale = scaleResult()
delete invalidServerScale.radar_scores.impulsivity
const preserved = mergeReport(localReport, {
  latest_scale: invalidServerScale,
  cognitive_profile: null,
  tracking_summary: null
})
assert.equal(preserved.scale.totalScore, 28)
assert.equal(preserved.scale.source, 'local')

const geometry = createRadarGeometry(
  localReport.scale.radarAxes,
  300,
  260,
  92
)
assert.deepEqual(geometry.center, { x: 150, y: 130 })
assert.equal(geometry.gridPolygons.length, 5)
assert.equal(geometry.gridPolygons.every((ring) => ring.length === 5), true)
assert.equal(geometry.dataPoints.length, 5)
assert.equal(geometry.labelPoints.length, 5)
assert.equal(createRadarGeometry([], 300, 260, 92), null)
assert.equal(createRadarGeometry(localReport.scale.radarAxes, 0, 260, 92), null)

console.log('综合报告数据测试全部通过')
