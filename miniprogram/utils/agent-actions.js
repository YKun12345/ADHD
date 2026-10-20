const ROUTES = Object.freeze({
  assessments: { path: 'assessments', roles: ['patient', 'researcher'], optional: ['assessment_id'] },
  doctor_review: { path: 'doctor-review', roles: ['researcher'], required: ['assessment_id'] },
  review_questions: { path: 'review-questions', roles: ['patient', 'researcher'], required: ['assessment_id'] },
  care_reports: { path: 'care-reports', roles: ['patient', 'researcher'], required: ['assessment_id'] },
  doctor_plan: { path: 'doctor-plan', roles: ['researcher'], required: ['assessment_id'] },
  patient_plan: { path: 'patient-plan', roles: ['patient'], required: ['assessment_id'] },
  care_cycles: { path: 'care-cycles', roles: ['patient'], required: ['cycle_id'] },
  cycle_review: { path: 'cycle-review', roles: ['patient', 'researcher'], required: ['cycle_id'] },
  care_attention: { path: 'care-attention', roles: ['patient', 'researcher'] }
})
const positive = value => Number.isInteger(value) && value > 0
function targetUrl(target, context) {
  const config = target && ROUTES[target.page_key], params = target && target.params
  if (!config || !config.roles.includes(context.role) || !params || params.patient_id !== context.patientId || !positive(params.patient_id) ||
    Object.keys(params).some(key => !['patient_id', ...(config.required || []), ...(config.optional || [])].includes(key) || !positive(params[key])) ||
    (config.required || []).some(key => !positive(params[key]))) throw new Error('助手动作与当前角色、档案或允许页面不一致，请刷新。')
  const fields = ['patient_id', ...(config.required || []), ...(config.optional || [])].filter(key => params[key] !== undefined)
  return `/pages/${config.path}/index?` + fields.map(key => `${key}=${encodeURIComponent(params[key])}`).join('&')
}
module.exports = { targetUrl }
