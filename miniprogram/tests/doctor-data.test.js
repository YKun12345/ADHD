const assert = require('node:assert/strict')

const {
  normalizeDashboard,
  normalizePatientReport,
  normalizeMessages,
  normalizeDoctorTasks,
  normalizeAiLogs,
  filterPatients,
  validateTaskDraft,
  isValidPatientId,
  validateMessage
} = require('../utils/doctor-data')

assert.deepEqual(normalizeDashboard(null, null), {
  stats: {
    patientCount: 0,
    pendingImagingCount: 0,
    weeklyReportCount: 0
  },
  total: 0,
  patients: []
})

const dashboard = normalizeDashboard(
  { patient_count: 2, pending_imaging_count: 1, weekly_report_count: 4 },
  {
    total: 1,
    items: [{
      patient_id: 8,
      patient_name: '患者甲',
      patient_email: 'patient@example.com',
      latest_scale_risk_level: 'high',
      completed_tracking_days: 6,
      cognitive_test_count: 3,
      next_step_text: '完成认知测评'
    }]
  }
)
assert.equal(dashboard.stats.patientCount, 2)
assert.equal(dashboard.patients[0].riskText, '高风险')
assert.equal(dashboard.patients[0].progressText, '随访 6 天 · 认知 3 项')

const report = normalizePatientReport({
  patient_id: 8,
  patient_name: '患者甲',
  patient_email: 'patient@example.com',
  latest_scale: {
    scale_type: 'ASRS',
    total_score: 18,
    risk_level: 'medium',
    summary: '需要继续观察。'
  },
  cognitive_profile: {
    summary: '工作记忆表现稳定。',
    latest_tests: [{ test_name: '工作记忆', status_text: '已完成', key_metric: '正确率 86%' }]
  },
  tracking_summary: { completed_count: 6, total_days: 14, latest_mood_text: '平静' },
  care_summary: ['保持规律作息'],
  suggested_actions: ['一周后复测']
  , latest_model_prediction: {
    prediction_label: 'ADHD', probability: 0.76, probability_control: 0.24,
    model_name: 'HGST', model_version: 'v2', source_type: 'fmri_hgst'
  }
})
assert.equal(report.patientName, '患者甲')
assert.equal(report.scale.riskText, '中风险')
assert.equal(report.cognitive.tests.length, 1)
assert.equal(report.tracking.progressText, '已记录 6/14 天')
assert.equal(report.professional.predictionLabel, 'ADHD')
assert.equal(report.professional.adhdProbabilityText, '76.0%')

assert.deepEqual(normalizeMessages({ items: [{ id: 1, sender_role: 'researcher', content: '  请按时复测  ', created_at: '2026-09-01T08:00:00Z' }] })[0].content, '请按时复测')
assert.equal(isValidPatientId('8'), true)
assert.equal(isValidPatientId('0'), false)
assert.equal(isValidPatientId('8x'), false)
assert.deepEqual(validateMessage('  继续加油  '), { ok: true, content: '继续加油' })
assert.equal(validateMessage('   ').ok, false)
assert.equal(validateMessage('x'.repeat(2001)).ok, false)

const doctorTasks = normalizeDoctorTasks({ items: [{
  id: 3, task_type: 'tracking', task_title: '每日记录', status: 'pending',
  due_at: '2026-09-08T08:00:00Z'
}] })
assert.equal(doctorTasks[0].statusLabel, '待完成')
assert.match(doctorTasks[0].dueAt, /2026-09-08/)

assert.equal(filterPatients(dashboard.patients, { query: '患者甲', risk: 'high', completion: 'all' }).length, 1)
assert.equal(filterPatients(dashboard.patients, { query: '乙', risk: 'all', completion: 'all' }).length, 0)
assert.equal(validateTaskDraft({ taskType: 'scale', title: '完成量表', description: '请在安静环境完成', dueDate: '2026-09-08' }).ok, true)
assert.equal(validateTaskDraft({ taskType: 'bad', title: '任务' }).ok, false)
assert.equal(validateTaskDraft({ taskType: 'scale', title: '  ' }).ok, false)
assert.equal(validateTaskDraft({ taskType: 'scale', title: '完成量表', description: '   ' }).ok, false)
assert.deepEqual(normalizeAiLogs({ items: [{ id: 1, scope: 'report', role: 'user', content: ' 请解释报告 ', created_at: '2026-09-01T08:00:00Z' }] })[0].content, '请解释报告')

console.log('医生端数据整理与输入校验测试全部通过')
