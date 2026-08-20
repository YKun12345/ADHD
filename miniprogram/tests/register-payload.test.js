const assert = require('node:assert/strict')

const {
  buildRegistrationPayload
} = require('../utils/register-payload')

const adultPayload = buildRegistrationPayload({
  fullName: '  张三  ',
  email: '  Patient@Example.COM  ',
  patientType: 'adult',
  age: '20',
  gender: 'female',
  password: 'BrainMap#2026',
  confirmPassword: 'BrainMap#2026',
  consentAgreed: true,
  showPassword: true,
  showConfirmPassword: true,
  submitting: true
})

assert.deepEqual(adultPayload, {
  email: 'patient@example.com',
  password: 'BrainMap#2026',
  full_name: '张三',
  role: 'patient',
  consent_agreed: true,
  patient_profile: {
    age: 20,
    gender: 'female',
    patient_type: 'adult'
  }
})

const childPayload = buildRegistrationPayload({
  fullName: '李小明',
  email: 'child@example.com',
  patientType: 'child',
  age: '10',
  gender: '',
  password: 'ChildSafe#2026',
  confirmPassword: 'ChildSafe#2026',
  consentAgreed: true,
  showPassword: false,
  showConfirmPassword: false,
  submitting: false
})

assert.deepEqual(childPayload.patient_profile, {
  age: 10,
  gender: null,
  patient_type: 'child'
})

for (const excludedField of [
  'confirmPassword',
  'showPassword',
  'showConfirmPassword',
  'submitting'
]) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(adultPayload, excludedField),
    false
  )
}

console.log('注册请求数据转换测试全部通过')
