const test = require('node:test')
const assert = require('node:assert/strict')
const { buildRegistrationPayload } = require('../utils/register-payload')
const { validateRegistration } = require('../utils/register-validation')

const child = {
  fullName: '合成儿童', email: 'guardian@example.com', patientType: 'child', age: '10',
  password: 'Synthetic#2026', confirmPassword: 'Synthetic#2026', consentAgreed: true,
  guardianName: '合成监护人', guardianAge: '35', guardianRelation: 'parent',
  proofReference: 'institution-test-reference', guardianConfirmed: true
}

test('child registration keeps account holder and assessed child separate', () => {
  const payload = buildRegistrationPayload(child)
  assert.equal(payload.full_name, '合成监护人')
  assert.equal(payload.patient_profile.display_name, '合成儿童')
  assert.equal(payload.patient_profile.age, 10)
  assert.deepEqual(payload.guardian, {
    age: 35, relation: 'parent', proof_reference: 'institution-test-reference', confirmed: true
  })
  assert.equal(Object.hasOwn(payload.guardian, 'status'), false)
})

test('child entry requires guardian identity and explicit confirmation', () => {
  assert.equal(validateRegistration(child), '')
  for (const change of [
    { guardianName: '' }, { guardianAge: '17' }, { guardianRelation: 'friend' },
    { guardianConfirmed: false }
  ]) assert.notEqual(validateRegistration({ ...child, ...change }), '', JSON.stringify(change))
})

test('child self-service needs no institution proof number', () => {
  assert.equal(validateRegistration({...child,proofReference:''}), '')
  assert.equal(Object.hasOwn(buildRegistrationPayload({...child,proofReference:''}).guardian,'proof_reference'),false)
})

test('choosing patient type cannot turn a minor into self or an adult into a child', () => {
  assert.notEqual(validateRegistration({ ...child, patientType: 'adult', age: '10' }), '')
  assert.notEqual(validateRegistration({ ...child, age: '18' }), '')
})
