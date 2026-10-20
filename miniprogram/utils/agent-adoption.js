const BACKGROUND = [
  { key: 'diagnosis_history', label: '既往评估情况' }, { key: 'medication', label: '相关用药情况' },
  { key: 'other_conditions', label: '其他健康情况' }, { key: 'sleep', label: '睡眠情况' },
  { key: 'school_work', label: '学习或工作情况' }
]
const positive = value => Number.isInteger(value) && value > 0
function profileRows(content) {
  const fields = content && content.fields
  return BACKGROUND.filter(row => !fields || Object.prototype.hasOwnProperty.call(fields, row.key)).map(row => ({ ...row,
    status: fields ? fields[row.key].status : 'skipped', value: fields ? fields[row.key].value || '' : '', confirmed: false }))
}
function profileContent(rows) {
  return { fields: Object.fromEntries(rows.map(row => [row.key, { status: row.status, value: row.status === 'provided' ? row.value : null }])) }
}
function adoptionUrl(row) {
  if (!row || !positive(row.patient_id) || !positive(row.id)) return ''
  const base = `patient_id=${row.patient_id}`
  if (row.target_type === 'assessment_background') return `/pages/assessments/index?${base}&ai_decision_id=${row.id}`
  if (row.target_type === 'cycle_review') return positive(row.cycle_id) ? `/pages/cycle-review/index?${base}&cycle_id=${row.cycle_id}&ai_decision_id=${row.id}` : ''
  const page = { review_question: 'review-questions', plan_publication: 'doctor-plan', shared_message: 'shared-messages', review_draft: 'doctor-review' }[row.target_type]
  return page && positive(row.assessment_id) ? `/pages/${page}/index?${base}&assessment_id=${row.assessment_id}&ai_decision_id=${row.id}` : ''
}
module.exports = { BACKGROUND, profileRows, profileContent, adoptionUrl }
