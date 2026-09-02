const assert = require('node:assert/strict')
const {
  normalizeCareSummary,
  normalizePatientMessages,
  normalizePatientTasks,
  validateCareMessage,
  createClientMessageId,
  getTaskNavigationUrl
} = require('../utils/patient-care')

assert.deepEqual(normalizeCareSummary({ unread_message_count: 3, pending_task_count: 2 }), {
  unreadMessageCount: 3,
  pendingTaskCount: 2
})
assert.deepEqual(normalizeCareSummary(null), { unreadMessageCount: 0, pendingTaskCount: 0 })

const messages = normalizePatientMessages({ items: [{
  id: 2,
  sender_role: 'researcher',
  sender_name: '王医生',
  content: '请完成本周任务',
  created_at: '2026-09-02T08:00:00Z'
}] })
assert.equal(messages[0].isMine, false)
assert.equal(messages[0].senderName, '王医生')
assert.match(messages[0].createdAt, /2026-09-02/)

const tasks = normalizePatientTasks({ items: [{
  id: 5,
  task_type: 'scale',
  task_title: '完成量表',
  status: 'expired',
  due_at: '2026-09-01T08:00:00Z',
  researcher_name: '王医生'
}] })
assert.equal(tasks[0].statusLabel, '已过期')
assert.equal(tasks[0].sourceLabel, '医生安排')
assert.equal(tasks[0].canComplete, false)
assert.equal(getTaskNavigationUrl(tasks[0]), '/pages/scale/index')
assert.equal(getTaskNavigationUrl({ taskType: 'unknown', targetPage: '/pages/login/index' }), '')

assert.deepEqual(validateCareMessage('  已收到  '), { ok: true, content: '已收到' })
assert.equal(validateCareMessage('   ').ok, false)
assert.equal(validateCareMessage('问'.repeat(2001)).ok, false)
assert.match(createClientMessageId(() => 1720000000000, () => 0.25), /^wx-[a-z0-9]+-[a-z0-9]+$/)
assert.equal(createClientMessageId(() => 1720000000000, () => 0.25).length <= 64, true)

console.log('患者消息与任务数据测试全部通过')
