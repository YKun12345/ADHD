function suggestedIntents(text, role) {
  if (typeof text !== 'string' || !text.trim()) return []
  if (role === 'researcher') {
    if (/(帮我|替我|准备|起草).{0,10}(补问|追问)/.test(text)) return [{ kind: 'review_questions', label: '准备本轮补问建议' }]
    if (/(帮我|替我|准备|起草).{0,10}计划/.test(text)) return [{ kind: 'plan_draft', label: '准备本轮计划建议' }]
    if (/(帮我|替我|准备|起草).{0,10}(回复|答复)/.test(text)) return [{ kind: 'reply_draft', label: '准备本轮回复建议' }]
  }
  if (/(告诉医生|发给医生|联系医生|反馈给医生)/.test(text) || role === 'researcher' && /(告诉用户|发给用户|联系用户|告诉患者|发给患者)/.test(text)) return [{ kind: 'message', label: role === 'researcher' ? '带入共享消息' : '整理后告诉医生' }]
  if (role === 'patient' && /(帮我|替我|我想|请).{0,8}(记录|记一下|记下来)/.test(text)) return [{ kind: 'daily', label: '带入今天的日期记录' }]
  return []
}
function originalNote(text) {
  return String(text || '').replace(/^(?:请)?(?:帮我|替我|我想)?(?:记录一下|记一下|记下来|记录|告诉医生|发给医生|反馈给医生)[：:，,\s]*/, '').trim()
}
module.exports = { suggestedIntents, originalNote }
