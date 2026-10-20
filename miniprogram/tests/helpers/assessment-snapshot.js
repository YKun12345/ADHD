const { getTaskConfig } = require('../../utils/cognitive-config')
const digest = 'a'.repeat(64)
function snapshot() {
  const attempt = { id: 53, patient_id: 8, assessment_id: 42, assessment_item_id: 71, run_id: 'server-fixed-run',
    actor_user_id: 7, performer_kind: 'patient', performer_user_id: null, performer_patient_id: 8,
    respondent_user_id: null, respondent_kind: null, submitter_user_id: 7, age_group: 'adult',
    protocol_id: 'continuous-mobile-v4', protocol_schema_version: 6, config_digest: digest,
    config_snapshot: getTaskConfig('flanker', 'adult'), template_digest: digest, execution_status: 'in_progress',
    metadata: { device: { platform: 'miniprogram', device_type: 'unknown', environment: 'unknown' },
      input: { method: 'unknown' }, timing: { clock_source: 'Date.now', unit: 'ms', calibrated: false },
      practice: { completed: false, attempts: 0, exposure_count: 0 }, assistance: { provided: false, kind: 'none' } } }
  return { id: 42, patient_id: 8, status: 'active', age_group: 'adult', demonstration_only: true, template_digest: digest,
    items: [{ id: 71, assessment_id: 42, patient_id: 8, kind: 'cognitive', instrument: 'flanker',
      config: attempt.config_snapshot, config_digest: digest, protocol_id: attempt.protocol_id, protocol_schema_version: 6,
      patient_task_id: null, allowed_actions: ['create_attempt'], attempts: [attempt] }] }
}
module.exports = { snapshot }
