const LABELS = {
  answer_questions: ['回答医生', '医生有一个具体问题想了解，我们一起看看。', 1],
  repeat_requested: ['查看重测', '这次可以按照医生的说明，重新安排一次尝试。', 2],
  receive_plan: ['阅读计划', '医生的新安排已经来了，先看看要做什么。', 3],
  record_today: ['记录今天', '只写今天真实发生的情况，不知道的可以留空。', 4],
  review_assessment: ['查看材料', '先看看本轮材料和需要你判断的地方。', 5],
  continue_assessment: ['继续评估', '从还没完成的项目继续，一次做一项。', 6],
  cycle_due: ['看看下一步', '这个阶段到期了，一起回顾记录和后续安排。', 7],
  self_cycle_due: ['回顾记录', '这段记录已经结束，我们看看接下来怎么安排。', 7],
  read_report: ['查看意见', '医生已发布意见，你可以随时再看。', 8],
  view_plan: ['查看计划', '看看已经确认的安排，再决定下一步工作。', 9],
  view_paused_plan: ['查看历史', '这个计划已暂停，可以查看之前的安排。', 10],
  view_attention: ['查看待办', '还有需要留意的事项，我们逐个处理。', 11],
  open_assessments: ['开始看看', '先选择适合当前档案的一轮评估。', 12]
}
function actionView(row, role) {
  const value = LABELS[row.kind] || ['一起看看', row.reason, 20]
  const leadText = role === 'researcher' && row.kind === 'read_report' ? '当前用户已有已发布的意见，可查看版本、来源和局限。' : value[1]
  return { ...row, buttonText: value[0], leadText }
}
function orderedActions(rows, resumeActionId = null, role) {
  const actions = rows.map((row, index) => ({ row, index })).sort((a, b) =>
    ((LABELS[a.row.kind] || [null,null,20])[2] - (LABELS[b.row.kind] || [null,null,20])[2]) || a.index - b.index
  ).map(value => actionView(value.row, role))
  const index = actions.findIndex(row => row.id === resumeActionId)
  if (index > 0) actions.unshift(actions.splice(index, 1)[0])
  return actions
}
module.exports = { actionView, orderedActions }
