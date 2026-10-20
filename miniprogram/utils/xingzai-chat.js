const PROFESSIONAL = ['assessment_summary', 'review_questions', 'plan_draft', 'reply_draft']

function presentRun(row, role) {
  const kind = row.intent || (row.artifact && row.artifact.kind) || 'question'
  const isAnswer = kind === 'question'
  const labels = {
    queued: '星仔马上来陪你', running: '星仔正在整理',
    completed: isAnswer ? '星仔已回答' : '建议已准备好',
    failed: '这次没有回答成功，可以稍后再试',
    stale: '资料有了变化，我们重新看看'
  }
  let answerNotice = ''
  if (isAnswer && row.question_mode === 'smart' && row.status === 'completed') {
    answerNotice = row.mode === 'remote' ? row.context_run_ids?.length ? 'DeepSeek 智能回答 · 本次文字及已确认的选中对话' : 'DeepSeek 智能回答 · 仅使用本次文字'
      : row.error_code === 'local_safety_boundary' ? '这类专业或安全问题由本机提示处理，未发送给外部模型。'
        : row.error_code === 'product_help_only' ? '星仔帮助使用小程序和解答注意力相关困惑，这次未向外部模型发送文字。'
        : '这次智能回答未完成，以下先提供本机帮助。外部请求可能已发出，请勿反复发送。'
  }
  return { isAnswer, answerNotice, canEditDraft: role === 'researcher' && PROFESSIONAL.includes(kind) && (kind !== 'review_questions' || Boolean(row.artifact?.body?.questions?.length)) ||
      kind === 'cycle_summary' && ['patient','researcher'].includes(role) || kind === 'profile_fields' && role === 'patient',
    statusLabel: labels[row.status] || '正在读取', working: ['queued', 'running'].includes(row.status) }
}

function helpPrompts(role) {
  return role === 'researcher'
    ? ['今天先处理什么？', '帮我看看材料是否齐全', '我该怎么发起评估？']
    : ['我现在应该做什么？', '怎么开始这轮评估？', '我做测试遇到了困难']
}

function serviceView(role) {
  return role === 'researcher'
    ? { serviceLabel: '医生助手 · 正在帮助你处理当前获准档案', welcomeText: '你好，我是星仔，现在为你提供医生端使用帮助。可以问我在哪里看用户报告、如何核对材料、补问或发布计划。你的聊天不会自动发给用户。' }
    : { serviceLabel: '用户助手 · 陪你使用当前档案', welcomeText: '你好，我是星仔。我会帮你用好小程序、查看报告，也可以聊聊分心、拖延等注意力相关困惑。你的聊天不会自动发给医生。' }
}

module.exports = { presentRun, helpPrompts, serviceView }
