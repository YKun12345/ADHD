const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const { snapshot } = require('./helpers/assessment-snapshot')
const query = { assessment_id: '42', item_id: '71', attempt_id: '53' }
function transport(h, server) {
  h.setRequest(async options => options.method !== 'POST' ? server : {
    ...Object.fromEntries(['submission_id', 'patient_id', 'assessment_id', 'assessment_item_id', 'attempt_id', 'run_id', 'task_id'].map(key => [key, options.data[key]])),
    submission_status: 'committed', execution_status: 'submitted', canonical_digest: 'a'.repeat(64), result: { kind: 'cognitive', id: 99, legacy: false }, quality_status: 'limited', acceptance_status: 'not_required'
  })
}
test('the actual formal Flanker page separates eight practice trials from 24 formal trials and queues the fixed server context', async () => {
  const h = createHarness()
  try {
    transport(h, snapshot())
    const page = h.load('flanker', { query }); await page._loadPromise
    h.start(page)
    assert.equal(page.data.practiceStage, true)
    assert.equal(page._trials.length, 8)
    for (let i = 0; i < 8; i++) {
      h.advance(100)
      page.handleAnswer({ currentTarget: { dataset: { direction: page._trials[i].target, trial: i + 1 } } })
      if (i < 7) h.advance(250)
    }
    assert.equal(page.data.practicePassed, true)
    assert.equal(page.data.running, false)
    assert.equal(h.requests.filter(value => value.method === 'POST').length, 0)
    page.handlePracticeContinue()
    assert.equal(page.data.practiceStage, false)
    assert.equal(page._trials.length, 24)
    for (let i = 0; i < 24; i++) {
      h.advance(100)
      page.handleAnswer({ currentTarget: { dataset: { direction: page._trials[i].target, trial: i + 1 } } })
      if (i < 23) h.advance(250)
    }
    await h.flush()
    const writes = h.requests.filter(value => value.method === 'POST')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].url, '/care/submissions')
    assert.equal(writes[0].data.run_id, 'server-fixed-run')
    assert.equal(writes[0].data.content.result_json.trials.length, 24)
    assert.equal(writes[0].data.content.execution_metadata.practice_records[0].trials.length, 8)
    assert.equal(writes[0].data.content.execution_metadata.practice.completed, true)
    assert.equal(page.data.syncStatus, '已提交 · 质量有局限 · 无需医生验收')
    page.startTest(); h.advance(3000); page.handleInstructionStart()
    assert.equal(h.requests.filter(value => value.method === 'POST').length, 1, '已完成的正式run不能本机重置后复用')
  } finally { h.restore() }
})

test('hiding an actual formal practice stops the run and requires a new server attempt', async () => {
  const h = createHarness()
  try {
    transport(h, snapshot())
    const page = h.load('flanker', { query }); await page._loadPromise
    h.start(page); page.onHide(); h.advance(10000); page.onShow(); h.advance(3000); page.handleInstructionStart()
    assert.equal(page.data.running, false)
    assert.match(page.data.executionError, /新尝试/)
    assert.equal(h.requests.filter(value => value.method === 'POST').length, 0)
    page.onUnload()
  } finally { h.restore() }
})
