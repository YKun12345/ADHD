const test = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

test('a prepared companion transfer is private, bound to the actual object and version, and consumed once', () => {
  const h = createHarness()
  try {
    const transfer = require('../utils/companion-transfer')
    const binding = { kind: 'daily', patientId: 8, cycleId: 3, recordDate: '2026-10-18', recordRevision: 0, cycleStatus: 'active', planVersionId: null }
    const id = transfer.prepare(binding, { note: '今天学习容易走神' })
    assert.equal(h.writes.length, 0)
    assert.equal(transfer.consume(id, { ...binding, cycleId: 9 }), null)
    const next = transfer.prepare(binding, { note: '今天学习容易走神' })
    assert.deepEqual(transfer.consume(next, binding), { note: '今天学习容易走神' })
    assert.equal(transfer.consume(next, binding), null)
    assert.equal(transfer.consume(id, binding), null)
  } finally { require('../utils/companion-transfer').clear(); h.restore() }
})

test('account changes, changed original versions, expiry and background clearing cannot carry private text', () => {
  const h = createHarness()
  try {
    const transfer = require('../utils/companion-transfer')
    const binding = { kind: 'message', patientId: 8, relationshipId: 20, revision: 2, contextDigest: 'a'.repeat(64) }
    let id = transfer.prepare(binding, { content: '准备给医生的原话' })
    assert.equal(transfer.consume(id, { ...binding, revision: 3 }), null)
    id = transfer.prepare(binding, { content: '准备给医生的原话' })
    h.storage.access_token = 'new-session'
    assert.equal(transfer.consume(id, binding), null)
    id = transfer.prepare(binding, { content: '准备给医生的原话' }); h.advance(600001)
    assert.equal(transfer.consume(id, binding), null)
    id = transfer.prepare(binding, { content: '准备给医生的原话' }); transfer.clear()
    assert.equal(transfer.consume(id, binding), null)
  } finally { require('../utils/companion-transfer').clear(); h.restore() }
})

test('conversation actions offer explicit business choices without inventing measurements or treating every question as a command', () => {
  const { suggestedIntents, originalNote } = require('../utils/companion-intent')
  assert.deepEqual(suggestedIntents('帮我记录：今天学习时走神了', 'patient').map(row => row.kind), ['daily'])
  assert.deepEqual(suggestedIntents('我想告诉医生今天很难集中', 'patient').map(row => row.kind), ['message'])
  assert.deepEqual(suggestedIntents('怎么提高注意力？', 'patient'), [])
  assert.deepEqual(suggestedIntents('帮我起草本轮计划', 'researcher').map(row => row.kind), ['plan_draft'])
  assert.equal(originalNote('帮我记录：今天有点累'), '今天有点累')
  assert.equal(originalNote('今天专注时间不知道'), '今天专注时间不知道')
})
test('failed hand-offs recover the original only in the same profile and live session; applied or background-cleared transfers do not', () => {
  const h = createHarness()
  try {
    const transfer = require('../utils/companion-transfer')
    const binding = { kind: 'message', patientId: 8, relationshipId: 20, revision: 2, contextDigest: 'a'.repeat(64) }
    const original = '告诉医生：这次任务我不理解'
    let id = transfer.prepare(binding, { content: original }, original)
    assert.equal(transfer.consume(id, { ...binding, revision: 3 }), null)
    assert.equal(transfer.recover(id, 8), original)
    assert.equal(transfer.recover(id, 8), null)
    id = transfer.prepare(binding, { content: original }, original); transfer.discard(id)
    assert.equal(transfer.recover(id, 8), original, 'a failed initial read remains recoverable after leaving the target')
    id = transfer.prepare(binding, { content: original }, original); transfer.consume(id, binding); transfer.complete(id)
    assert.equal(transfer.recover(id, 8), null)
    id = transfer.prepare(binding, { content: original }, original); transfer.clear(); assert.equal(transfer.recover(id, 8), null)
    id = transfer.prepare(binding, { content: original }, original); h.storage.access_token = 'changed'; assert.equal(transfer.recover(id, 8), null)
    id = transfer.prepare(binding, { content: original }, original); assert.equal(transfer.recover(id, 9), null)
    assert.equal(h.writes.length, 0)
  } finally { require('../utils/companion-transfer').clear(); h.restore() }
})
