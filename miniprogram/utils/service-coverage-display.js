const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
function workingPeriodsText(periods) {
  const byDay = {}
  for (const period of periods) (byDay[period.weekday] || (byDay[period.weekday] = [])).push(`${period.start}-${period.end}`)
  const groups = {}
  for (const day of Object.keys(byDay).map(Number).sort((a, b) => a - b)) {
    const times = byDay[day].sort().join('、')
    ;(groups[times] || (groups[times] = [])).push(day)
  }
  return Object.keys(groups).map(times => {
    const values = groups[times], consecutive = values.length > 1 && values.every((day, index) => day === values[0] + index)
    return `${consecutive ? days[values[0]] + '至' + days[values[values.length - 1]] : values.map(day => days[day]).join('、')} ${times}`
  }).join('；')
}
function coverageText(value) {
  if (!value || value.status !== 'configured') return '服务覆盖未配置或原配置权限已变化；没有全天响应或紧急处置承诺。'
  const row = value.coverage
  if (!row || !Number.isInteger(row.version) || row.version < 1 || row.timezone !== 'Asia/Shanghai' || !Array.isArray(row.working_periods) ||
    !Number.isInteger(row.expected_response_working_minutes) || row.expected_response_working_minutes < 1 || typeof row.escalation_instructions !== 'string' ||
    row.working_periods.some(period => !days[period.weekday] || typeof period.start !== 'string' || typeof period.end !== 'string')) throw new Error('覆盖版本不一致')
  const periods = workingPeriodsText(row.working_periods)
  return `机构 ${row.institution_id} · 医生账号 ${row.doctor_user_id} · 版本 ${row.version}；${periods}（北京时间）。期望窗口 ${row.expected_response_working_minutes} 个工作分钟。现实流程：${row.escalation_instructions}。配置记录不表示真实机构上线准入已核验。`
}
module.exports = { coverageText }
