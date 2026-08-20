const COMMON_WEAK_PASSWORDS = [
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

function validateRegistration(form = {}) {
  const fullName = String(form.fullName || '').trim()
  const email = String(form.email || '').trim()
  const patientType = form.patientType || ''
  const age = String(form.age ?? '').trim()
  const password = String(form.password || '')
  const confirmPassword = String(form.confirmPassword || '')

  if (!fullName) {
    return '请输入患者姓名'
  }

  if (fullName.length < 2) {
    return '患者姓名至少需要2个字符'
  }

  if (fullName.length > 100) {
    return '患者姓名不能超过100个字符'
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

  if (!emailPattern.test(email)) {
    return '请输入正确的邮箱地址'
  }

  if (password.length < 8) {
    return '密码长度不能少于8位'
  }

  if (password.length > 128) {
    return '密码长度不能超过128位'
  }

  if (/^\d+$/.test(password)) {
    return '密码不能为纯数字'
  }

  if (COMMON_WEAK_PASSWORDS.includes(password.toLowerCase())) {
    return '当前密码过于常见'
  }

  if (password !== confirmPassword) {
    return '两次输入的密码不一致'
  }

  if (!patientType) {
    return '请选择患者类型'
  }

  if (!['adult', 'child'].includes(patientType)) {
    return '患者类型不正确'
  }

  const ageNumber = Number(age)

  if (
    !age ||
    !Number.isInteger(ageNumber) ||
    ageNumber < 1 ||
    ageNumber > 120
  ) {
    return '年龄必须是1至120之间的整数'
  }

  if (form.consentAgreed !== true) {
    return '请阅读并同意知情同意说明'
  }

  return ''
}

module.exports = {
  COMMON_WEAK_PASSWORDS,
  validateRegistration
}
