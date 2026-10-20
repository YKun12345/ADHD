const { test } = require('node:test'), assert = require('node:assert/strict')
test('agent targets permit only actual business pages and the fixed role and profile', () => {
  const { targetUrl } = require('../utils/agent-actions')
  const target = { page_key: 'doctor_review', params: { patient_id: 8, assessment_id: 42 } }
  assert.equal(targetUrl(target, { role: 'researcher', patientId: 8 }), '/pages/doctor-review/index?patient_id=8&assessment_id=42')
  for (const [value, context] of [[target, { role: 'patient', patientId: 8 }], [target, { role: 'researcher', patientId: 9 }],
    [{ page_key: 'https://invalid.example', params: { patient_id: 8 } }, { role: 'researcher', patientId: 8 }],
    [{ ...target, params: { ...target.params, next_url: 'https://invalid.example' } }, { role: 'researcher', patientId: 8 }]]) {
    assert.throws(() => targetUrl(value, context))
  }
})
