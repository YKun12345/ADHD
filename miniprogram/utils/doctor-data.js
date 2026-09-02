const RISK_TEXT = Object.freeze({
  high: '高风险',
  medium: '中风险',
  low: '低风险'
})
const { normalizeProfessionalData } = require('./report-data')

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback
}

function riskText(value) {
  return RISK_TEXT[value] || '暂无风险分级'
}

function normalizeDashboard(statsPayload, patientsPayload) {
  const stats = statsPayload && typeof statsPayload === 'object'
    ? statsPayload
    : {}
  const patientList = patientsPayload && typeof patientsPayload === 'object'
    ? patientsPayload
    : {}
  const patients = safeArray(patientList.items).map((item) => {
    const patient = item && typeof item === 'object' ? item : {}
    const trackingDays = Math.max(0, finiteNumber(patient.completed_tracking_days))
    const cognitiveCount = Math.max(0, finiteNumber(patient.cognitive_test_count))
    const patientName = text(patient.patient_name, '未命名患者')
    return {
      patientId: finiteNumber(patient.patient_id),
      patientName,
      avatarText: patientName.substring(0, 1),
      patientEmail: text(patient.patient_email, '未提供邮箱'),
      patientType: text(patient.patient_type),
      riskLevel: text(patient.latest_scale_risk_level),
      riskText: riskText(patient.latest_scale_risk_level),
      progressText: `随访 ${trackingDays} 天 · 认知 ${cognitiveCount} 项`,
      nextStepText: text(patient.next_step_text, '查看报告并安排下一步'),
      hasImaging: patient.has_imaging === true
    }
  }).filter((item) => item.patientId > 0)

  return {
    stats: {
      patientCount: Math.max(0, finiteNumber(stats.patient_count)),
      pendingImagingCount: Math.max(0, finiteNumber(stats.pending_imaging_count)),
      weeklyReportCount: Math.max(0, finiteNumber(stats.weekly_report_count))
    },
    total: Math.max(0, finiteNumber(patientList.total, patients.length)),
    patients
  }
}

function normalizePatientReport(payload) {
  const report = payload && typeof payload === 'object' ? payload : {}
  const scalePayload = report.latest_scale && typeof report.latest_scale === 'object'
    ? report.latest_scale
    : null
  const cognitivePayload = report.cognitive_profile && typeof report.cognitive_profile === 'object'
    ? report.cognitive_profile
    : null
  const trackingPayload = report.tracking_summary && typeof report.tracking_summary === 'object'
    ? report.tracking_summary
    : null

  const scale = scalePayload ? {
    type: text(scalePayload.scale_type, '量表'),
    totalScore: finiteNumber(scalePayload.total_score),
    riskLevel: text(scalePayload.risk_level),
    riskText: riskText(scalePayload.risk_level),
    summary: text(scalePayload.summary, '暂无量表摘要')
  } : null

  const cognitive = cognitivePayload ? {
    summary: text(cognitivePayload.summary, '暂无认知测评摘要'),
    tests: safeArray(cognitivePayload.latest_tests).map((item) => ({
      name: text(item && item.test_name, '认知测评'),
      status: text(item && item.status_text, '已记录'),
      metric: text(item && item.key_metric, '暂无关键指标')
    }))
  } : null

  const completedCount = trackingPayload
    ? Math.max(0, finiteNumber(trackingPayload.completed_count))
    : 0
  const totalDays = trackingPayload
    ? Math.max(0, finiteNumber(trackingPayload.total_days, 14))
    : 14
  const tracking = trackingPayload ? {
    progressText: `已记录 ${completedCount}/${totalDays} 天`,
    moodText: text(trackingPayload.latest_mood_text, '暂无情绪记录'),
    focusText: trackingPayload.average_focus_minutes === null || trackingPayload.average_focus_minutes === undefined
      ? '暂无专注时长'
      : `平均专注 ${Math.max(0, finiteNumber(trackingPayload.average_focus_minutes))} 分钟`
  } : null

  return {
    patientId: finiteNumber(report.patient_id),
    patientName: text(report.patient_name, '患者报告'),
    patientEmail: text(report.patient_email),
    patientType: text(report.patient_type),
    scale,
    cognitive,
    tracking,
    careSummary: safeArray(report.care_summary).map((item) => text(item)).filter(Boolean),
    suggestedActions: safeArray(report.suggested_actions).map((item) => text(item)).filter(Boolean),
    hasImaging: Boolean(report.latest_imaging_visualization),
    hasModelPrediction: Boolean(report.latest_model_prediction),
    professional: normalizeProfessionalData(report)
  }
}

function formatTime(value) {
  if (typeof value !== 'string' || !value) return ''
  return value.replace('T', ' ').replace(/\.\d+(?=Z|[+-]\d\d:\d\d$)/, '').replace(/Z$/, '')
}

function normalizeMessages(payload) {
  const items = Array.isArray(payload)
    ? payload
    : safeArray(payload && payload.items)
  return items.map((item) => ({
    id: finiteNumber(item && item.id),
    senderRole: text(item && item.sender_role),
    isDoctor: item && item.sender_role === 'researcher',
    content: text(item && item.content),
    createdAt: formatTime(item && item.created_at)
  })).filter((item) => item.id > 0 && item.content)
}

function normalizeDoctorTasks(payload) {
  const items = Array.isArray(payload) ? payload : safeArray(payload && payload.items)
  const labels = { pending: '待完成', completed: '已完成', expired: '已过期', dismissed: '已取消' }
  return items.map((item) => {
    const status = text(item && item.status, 'pending')
    return {
      id: finiteNumber(item && item.id),
      taskType: text(item && item.task_type),
      title: text(item && item.task_title, '随访任务'),
      description: text(item && item.task_description),
      status,
      statusLabel: labels[status] || '待确认',
      dueAt: formatTime(item && item.due_at)
    }
  }).filter((item) => item.id > 0)
}

function normalizeAiLogs(payload) {
  const items = Array.isArray(payload) ? payload : safeArray(payload && payload.items)
  return items.slice(0, 6).map((item) => ({
    id: finiteNumber(item && item.id),
    role: text(item && item.role),
    scope: text(item && item.scope, 'general'),
    content: text(item && item.content).slice(0, 120),
    createdAt: formatTime(item && item.created_at)
  })).filter((item) => item.id > 0 && item.content)
}

function filterPatients(patients, filters = {}) {
  const query = text(filters.query).toLowerCase()
  const risk = text(filters.risk, 'all')
  const completion = text(filters.completion, 'all')
  return safeArray(patients).filter((patient) => {
    const matchesQuery = !query || `${patient.patientName} ${patient.patientEmail}`.toLowerCase().includes(query)
    const matchesRisk = risk === 'all' || patient.riskLevel === risk
    const matchesCompletion = completion === 'all' || (
      completion === 'complete'
        ? /随访 14 天/.test(patient.progressText)
        : !/随访 14 天/.test(patient.progressText)
    )
    return matchesQuery && matchesRisk && matchesCompletion
  })
}

function validateTaskDraft(draft = {}) {
  const taskType = text(draft.taskType)
  const title = text(draft.title)
  const description = text(draft.description)
  const dueDate = text(draft.dueDate)
  if (!['scale', 'cognitive', 'tracking', 'report_review'].includes(taskType)) return { ok: false, message: '请选择任务类型' }
  if (!title) return { ok: false, message: '请填写任务标题' }
  if (title.length > 120) return { ok: false, message: '任务标题不能超过 120 个字' }
  if (!description) return { ok: false, message: '请填写任务说明' }
  if (description.length > 1000) return { ok: false, message: '任务说明不能超过 1000 个字' }
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { ok: false, message: '截止日期格式不正确' }
  return { ok: true, taskType, title, description, dueDate }
}

function isValidPatientId(value) {
  if (!/^\d+$/.test(String(value || ''))) return false
  const patientId = Number(value)
  return Number.isInteger(patientId) && patientId > 0
}

function validateMessage(value) {
  const content = text(value)
  if (!content) return { ok: false, message: '请输入消息内容' }
  if (content.length > 2000) return { ok: false, message: '消息不能超过 2000 个字' }
  return { ok: true, content }
}

module.exports = {
  normalizeDashboard,
  normalizePatientReport,
  normalizeMessages,
  normalizeDoctorTasks,
  normalizeAiLogs,
  filterPatients,
  validateTaskDraft,
  isValidPatientId,
  validateMessage
}
