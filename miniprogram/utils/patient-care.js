const STATUS_LABELS = Object.freeze({
  pending: '待完成', completed: '已完成', expired: '已过期', dismissed: '已取消'
})
const TASK_URLS = Object.freeze({
  scale: '/pages/scale/index',
  cognitive: '/pages/cognitive-center/index',
  tracking: '/pages/tracking/index',
  report_review: '/pages/report/index'
})

function items(payload) {
  return Array.isArray(payload) ? payload : Array.isArray(payload && payload.items) ? payload.items : []
}
function clean(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}
function count(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : 0
}
function formatTime(value) {
  return clean(value).replace('T', ' ').replace(/\.\d+(?=Z|[+-]\d\d:\d\d$)/, '').replace(/Z$/, '')
}

function normalizeCareSummary(payload) {
  const value = payload && typeof payload === 'object' ? payload : {}
  return {
    unreadMessageCount: count(value.unread_message_count),
    pendingTaskCount: count(value.pending_task_count)
  }
}

function normalizePatientMessages(payload) {
  return items(payload).map((item) => ({
    id: Number(item && item.id) || 0,
    isMine: item && item.sender_role === 'patient',
    senderName: clean(item && item.sender_name, item && item.sender_role === 'patient' ? '我' : '医生'),
    content: clean(item && item.content),
    createdAt: formatTime(item && item.created_at),
    status: 'sent'
  })).filter((item) => item.id > 0 && item.content)
}

function normalizePatientTasks(payload) {
  return items(payload).map((item) => {
    const status = clean(item && item.status, 'pending')
    return {
      id: Number(item && item.id) || 0,
      taskType: clean(item && item.task_type),
      title: clean(item && item.task_title, '随访任务'),
      description: clean(item && item.task_description),
      status,
      statusLabel: STATUS_LABELS[status] || '待确认',
      sourceLabel: '医生安排',
      doctorName: clean(item && item.researcher_name, '医生'),
      dueAt: formatTime(item && item.due_at),
      targetPage: clean(item && item.target_page),
      canComplete: status === 'pending'
    }
  }).filter((item) => item.id > 0)
}

function validateCareMessage(value) {
  const content = clean(value)
  if (!content) return { ok: false, message: '请输入回复内容' }
  if (content.length > 2000) return { ok: false, message: '消息不能超过 2000 个字' }
  return { ok: true, content }
}

function createClientMessageId(nowProvider = Date.now, randomProvider = Math.random) {
  const now = Math.max(0, Math.floor(Number(nowProvider()) || 0)).toString(36)
  const random = Math.floor(
    Math.max(0, Math.min(0.999999999999, Number(randomProvider()) || 0)) * 1000000000000
  ).toString(36)
  return `wx-${now}-${random}`.slice(0, 64)
}

function getTaskNavigationUrl(task) {
  return task && Object.prototype.hasOwnProperty.call(TASK_URLS, task.taskType)
    ? TASK_URLS[task.taskType]
    : ''
}

module.exports = {
  normalizeCareSummary,
  normalizePatientMessages,
  normalizePatientTasks,
  validateCareMessage,
  createClientMessageId,
  getTaskNavigationUrl
}
