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

  if (patientType === 'adult' && ageNumber < 18) return '本人使用需年满18岁，请选择为儿童使用'
  if (patientType === 'child') {
    if (ageNumber >= 18) return '儿童档案需未满18岁，成年转换须核验本人身份'
    const guardianName = String(form.guardianName || '').trim()
    if (guardianName.length < 2 || guardianName.length > 100) return '请填写主要监护人姓名'
    const guardianAge = Number(form.guardianAge)
    if (!Number.isInteger(guardianAge) || guardianAge < 18 || guardianAge > 120) return '监护人年龄须为18至120之间的整数'
    if (!['parent', 'legal_guardian'].includes(form.guardianRelation)) return '请选择监护关系'
    if (String(form.proofReference || '').length > 200) return '监护关系说明不能超过200个字符'
    if (form.guardianConfirmed !== true) return '请确认主要监护关系及儿童使用说明'
  }

  return ''
}

module.exports = {
  COMMON_WEAK_PASSWORDS,
  validateRegistration
}
