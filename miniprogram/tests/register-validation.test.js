const assert = require('node:assert/strict')

const {
  COMMON_WEAK_PASSWORDS,
  validateRegistration
} = require('../utils/register-validation')

const expectedWeakPasswords = [
  '12345678',
  '123456789',
  '1234567890',
  '00000000',
  '11111111',
  '123123123',
  '87654321',
  'password',
  'password123',
  'admin123',
  'qwerty123',
  'qwertyuiop',
  'asdfghjk',
  'abcd1234',
  'welcome123',
  'iloveyou',
  '1q2w3e4r',
  'aa123456'
]

const validAdultForm = {
  fullName: '张三',
  email: 'patient@example.com',
  patientType: 'adult',
  age: '20',
  gender: 'undisclosed',
  password: 'BrainMap#2026',
  confirmPassword: 'BrainMap#2026',
  consentAgreed: true
}

const validChildForm = {
  ...validAdultForm,
  fullName: '李小明',
  email: 'child@example.com',
  patientType: 'child',
  age: '10'
}

function expectError(changes, expectedMessage) {
  const result = validateRegistration({
    ...validAdultForm,
    ...changes
  })

  assert.equal(result, expectedMessage)
}

assert.deepEqual(COMMON_WEAK_PASSWORDS, expectedWeakPasswords)

expectError({ fullName: '' }, '请输入患者姓名')
expectError({ fullName: '张' }, '患者姓名至少需要2个字符')
expectError({ fullName: '张'.repeat(101) }, '患者姓名不能超过100个字符')
expectError({ email: 'wrong-email' }, '请输入正确的邮箱地址')

expectError(
  { password: 'Abc123', confirmPassword: 'Abc123' },
  '密码长度不能少于8位'
)
expectError(
  { password: 'A'.repeat(129), confirmPassword: 'A'.repeat(129) },
  '密码长度不能超过128位'
)
expectError(
  { password: '87654321', confirmPassword: '87654321' },
  '密码不能为纯数字'
)

for (const password of COMMON_WEAK_PASSWORDS) {
  const expectedMessage = /^\d+$/.test(password)
    ? '密码不能为纯数字'
    : '当前密码过于常见'

  expectError({ password, confirmPassword: password }, expectedMessage)
}

expectError(
  { confirmPassword: 'Different#2026' },
  '两次输入的密码不一致'
)
expectError({ patientType: '' }, '请选择患者类型')
expectError({ patientType: 'teenager' }, '患者类型不正确')

for (const age of ['', '1.5', 'abc', '0', '121']) {
  expectError({ age }, '年龄必须是1至120之间的整数')
}

expectError(
  { consentAgreed: false },
  '请阅读并同意知情同意说明'
)
expectError(
  { consentAgreed: 'true' },
  '请阅读并同意知情同意说明'
)

assert.equal(validateRegistration(validAdultForm), '')
assert.equal(validateRegistration(validChildForm), '')

console.log('注册表单校验测试全部通过')
