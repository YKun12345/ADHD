const test = require('node:test')
const assert = require('node:assert/strict')
const token = value => `unified-agent-run-context.v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${'a'.repeat(64)}`
test('only completed ordinary questions can be chosen; preview must match every selected source and signed scope', () => {
  const d = require('../utils/companion-dialogue')
  const rows = [{ run_id: 1, intent: 'question', status: 'completed', original_message: '怎么记日期？', replyText: '打开日期记录。' },
    { run_id: 2, intent: 'plan_draft', status: 'completed', original_message: '专业草稿', replyText: '不能外发' },
    { run_id: 3, intent: 'question', status: 'running', original_message: '等待' }]
  assert.deepEqual(d.contextChoices(rows).map(row => row.run_id), [1])
  const preview = { policy_version: 'Xingzai-selected-dialogue-1', turns: [{ run_id: 1, user_message: rows[0].original_message, assistant_message: rows[0].replyText }], digest: 'b'.repeat(64) }
  const ctx = { question_mode: 'smart', external_ai: { field_policy_version: preview.policy_version }, conversation_preview: preview }
  assert.deepEqual(d.verifiedPreview({ ...ctx, run_context: token(ctx) }, [1], rows), preview)
  assert.throws(() => d.verifiedPreview({ ...ctx, run_context: token(ctx) }, [2], rows))
  assert.throws(() => d.verifiedPreview({ ...ctx, conversation_preview: { ...preview, turns: [{ ...preview.turns[0], assistant_message: '被替换' }] }, run_context: token(ctx) }, [1], rows))
  const emoji = { ...rows[0], original_message: '🙂'.repeat(2000), replyText: 'ok' }
  assert.equal(d.contextChoices([emoji]).length, 1)
  assert.equal(d.validPreview({ ...preview, turns: [{ run_id: 1, user_message: emoji.original_message, assistant_message: 'ok' }] }, [1]), true)
})
