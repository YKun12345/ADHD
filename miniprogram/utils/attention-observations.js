const instant = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
function describeOverdue(row, formatTime) {
  const value = row.overdue_observation
  if (!value) return ''
  if (row.owner_kind !== 'doctor' || value.system_principal !== 'attention_deadline_monitor' || value.human_action !== false ||
    !['requires_institutional_action', 'historical'].includes(value.status) || value.external_delivery_status !== 'not_configured' ||
    !instant(value.original_deadline) || !instant(value.observed_at) || value.original_deadline !== row.expected_response_at ||
    Date.parse(value.observed_at) < Date.parse(value.original_deadline) || typeof value.institutional_instructions !== 'string' || !value.institutional_instructions.trim()) throw new Error('超时观察来源不一致')
  const status = value.status === 'requires_institutional_action' ? '已超过原期望窗口，站内升级记录已保存；事项仍待机构处理。' : '历史超时记录已保留，请结合当前事项状态查看。'
  return `${status}后台核对时间：${formatTime(value.observed_at)}。机构现实流程：${value.institutional_instructions}。外部通知未配置。`
}
module.exports = { describeOverdue }
