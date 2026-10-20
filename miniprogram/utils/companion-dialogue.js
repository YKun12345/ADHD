const { decodeOriginalContext } = require('./original-context')
const POLICY = 'Xingzai-selected-dialogue-1'
const clone = value => JSON.parse(JSON.stringify(value))
const length = value => Array.from(value).length
function contextChoices(runs) {
  return runs.filter(row => row.intent === 'question' && row.status === 'completed' && typeof row.original_message === 'string' &&
    typeof row.replyText === 'string' && row.replyText.trim() && length(row.original_message) + length(row.replyText) <= 4000)
    .slice(-4).map(row => ({ run_id: row.run_id, user_message: row.original_message, assistant_message: row.replyText, label: row.original_message.slice(0, 36) }))
}
function validPreview(preview, ids) {
  return preview && preview.policy_version === POLICY && /^[a-f0-9]{64}$/.test(preview.digest) && Array.isArray(ids) && ids.length > 0 && ids.length <= 2 &&
    ids.every(id => Number.isInteger(id) && id > 0) && new Set(ids).size === ids.length && Array.isArray(preview.turns) && preview.turns.length === ids.length &&
    preview.turns.every((row,i) => row.run_id === ids[i] && typeof row.user_message === 'string' && typeof row.assistant_message === 'string') &&
    preview.turns.reduce((sum,row) => sum + length(row.user_message) + length(row.assistant_message), 0) <= 4000
}
function verifiedPreview(ctx, ids, runs) {
  const preview = ctx.conversation_preview, signed = decodeOriginalContext(ctx.run_context, 'unified-agent-run-context')
  if (!validPreview(preview, ids) || !signed || signed.conversation_preview?.policy_version !== preview.policy_version || signed.conversation_preview?.digest !== preview.digest ||
    !validPreview(signed.conversation_preview, ids) || signed.conversation_preview.turns.some((row, i) =>
      row.run_id !== preview.turns[i].run_id || row.user_message !== preview.turns[i].user_message || row.assistant_message !== preview.turns[i].assistant_message) ||
    ctx.question_mode !== 'smart' || ctx.external_ai?.field_policy_version !== POLICY || signed.external_ai?.field_policy_version !== POLICY ||
    preview.turns.some(turn => !contextChoices(runs).some(row => row.run_id === turn.run_id && row.user_message === turn.user_message && row.assistant_message === turn.assistant_message))) {
    throw new Error('选中对话或发送范围有变化，请刷新后重新选择。')
  }
  return clone(preview)
}
module.exports = { POLICY, contextChoices, validPreview, verifiedPreview }
