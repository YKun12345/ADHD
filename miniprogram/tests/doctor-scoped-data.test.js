const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeDashboard, normalizePatientReport, filterPatients } = require('../utils/doctor-data')

test('unshared fields are described as unshared rather than zero or absent evidence', () => {
  const result = normalizeDashboard({ patient_count: 1, pending_imaging_count: null, weekly_report_count: null }, {
    total: 1, items: [{ patient_id: 8, allowed_scope: ['care'], patient_name: null, patient_email: null,
      latest_scale_risk_level: null, completed_tracking_days: null, cognitive_test_count: null, has_imaging: null }]
  })
  assert.equal(result.stats.pendingImagingCount, '未共享')
  assert.equal(result.stats.weeklyReportCount, '未共享')
  assert.equal(result.patients[0].patientName, '共享档案 #8')
  assert.equal(result.patients[0].riskText, '评估未共享')
  assert.equal(result.patients[0].progressText, '跟踪未共享 · 认知未共享')
  assert.equal(filterPatients(result.patients, { completion: 'incomplete' }).length, 0)
  assert.equal(filterPatients(result.patients, { risk: 'low' }).length, 0)
})

test('an assessment-only report keeps real scale evidence and identifies unshared imaging', () => {
  const result = normalizePatientReport({ patient_id: 8, allowed_scope: ['assessment'], patient_name: null,
    latest_scale: { scale_type: 'ASRS', total_score: 72, risk_level: 'high', summary: '合成量表摘要' },
    tracking_summary: null, latest_imaging_visualization: null, latest_model_prediction: null })
  assert.equal(result.patientName, '共享档案 #8')
  assert.equal(result.scale.totalScore, 72)
  assert.equal(result.hasImaging, null)
  assert.equal(result.imagingStatusText, '影像未共享')
  assert.equal(result.assessmentShared, true)
  assert.equal(result.trackingShared, false)
})
