const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const { getTaskConfig } = require('../utils/cognitive-config')
const { snapshot } = require('./helpers/assessment-snapshot')
function executionModule() {
  const id = require.resolve('../utils/assessment-execution'); delete require.cache[id]; return require(id)
}
const query = { assessment_id: '42', item_id: '71', attempt_id: '53' }

test('formal execution loads the server attempt and binds the original identity, config and run to the durable submission', async () => {
  const h = createHarness()
  try {
    const server = snapshot(); h.setRequest(async () => server)
    const execution = executionModule()
    const context = await execution.loadExecution(query, 'flanker')
    assert.equal(h.requests[0].url, '/care/assessments/42')
    const payload = execution.buildSubmission(context, { test_type: 'flanker', result_json: { trials: [] } })
    assert.equal(payload.run_id, 'server-fixed-run')
    assert.equal(payload.attempt_id, 53)
    assert.equal(payload.performer_user_id, null)
    assert.equal(payload.performer_patient_id, 8)
    assert.equal(payload.task_id, null)
    assert.equal(payload.actor_user_id, 7)
    server.items[0].attempts[0].run_id = 'mutated-response'
    assert.equal(execution.buildSubmission(context, {}).run_id, 'server-fixed-run')
    assert.equal('access_token' in payload, false)
  } finally { h.restore() }
})

test('a partial deep link, wrong task, altered config and substituted actor cannot fall back to legacy submission', async () => {
  const h = createHarness()
  try {
    const execution = executionModule()
    for (const mutation of [value => { value.items[0].instrument = 'nback' }, value => { value.items[0].attempts[0].actor_user_id = 99 },
      value => { value.items[0].attempts[0].config_snapshot = { ...getTaskConfig('flanker', 'adult'), formalTrials: 2 } }]) {
      const value = snapshot(); mutation(value); h.setRequest(async () => value)
      await assert.rejects(execution.loadExecution(query, 'flanker'))
    }
    await assert.rejects(execution.loadExecution({ attempt_id: '53' }, 'flanker'))
    assert.equal(await execution.loadExecution({}, 'flanker'), null)
  } finally { h.restore() }
})

test('a late server context and a changed account cannot continue a formal execution', async () => {
  const h = createHarness()
  try {
    const execution = executionModule()
    let release
    h.setRequest(() => new Promise(resolve => { release = resolve }))
    const loading = execution.loadExecution(query, 'flanker')
    storageReplacement(h)
    release(snapshot())
    await assert.rejects(loading)
  } finally { h.restore() }
})
function storageReplacement(h) {
  require('../utils/session-privacy').replacePatientSession({ token: 'synthetic-B', user: { id: 9, role: 'patient', patient_profile: { id: 10 } } })
}

test('starting a formal attempt is durable and a reload cannot reuse a started run after interruption', async () => {
  const h = createHarness()
  try {
    h.setRequest(async () => snapshot())
    const execution = executionModule(), context = await execution.loadExecution(query, 'flanker')
    execution.beginExecution(context)
    const reloaded = await execution.loadExecution(query, 'flanker')
    assert.throws(() => execution.beginExecution(reloaded), /新尝试/)
    assert.equal(execution.buildSubmission(context, {}).run_id, 'server-fixed-run')
  } finally { h.restore() }
})

test('formal evidence uses the configured API owner and rejects an actual changed device before submission', async () => {
  const h = createHarness()
  try {
    h.storage.api_base_url = 'http://127.0.0.1:8099/api/v1'
    h.setRequest(async () => snapshot())
    const execution = executionModule(), context = await execution.loadExecution(query, 'flanker')
    assert.equal(context.owner.api_origin, 'http://127.0.0.1:8099/api/v1')
    wx.getSystemInfoSync = () => ({ platform: 'android', windowWidth: 390, windowHeight: 844, model: 'changed-phone' })
    assert.throws(() => execution.assertDeviceUnchanged(context), /新尝试/)
  } finally { h.restore() }
})

test('actual account replacement removes both the owned execution marker and formal scale drafts', async () => {
  const h = createHarness()
  try {
    h.setRequest(async () => snapshot())
    const execution = executionModule(), context = await execution.loadExecution(query, 'flanker')
    execution.beginExecution(context); execution.saveScaleDraft(context, [1, 2])
    assert.ok(h.storage.assessment_execution_v1)
    assert.ok(h.storage.assessment_scale_drafts_v1)
    storageReplacement(h)
    assert.equal(h.storage.assessment_execution_v1, undefined)
    assert.equal(h.storage.assessment_scale_drafts_v1, undefined)
  } finally { h.restore() }
})

test('a real requested successor enters formal execution under review, while an unrelated attempt remains blocked', async () => {
  const h = createHarness()
  try {
    const source = snapshot(); source.status = 'under_review'; const item = source.items[0], attempt = item.attempts[0]
    item.allowed_actions = []
    item.repeat_request = { report_id: 91, source_attempt_id: 52, continuing_attempt_id: attempt.id }
    attempt.metadata.repeat_request = { report_id: 91, source_attempt_id: 52, assessment_item_id: item.id }
    h.setRequest(async () => source); const execution = executionModule()
    const context = await execution.loadExecution(query, 'flanker')
    execution.beginExecution(context)
    assert.equal(execution.buildSubmission(context, {}).attempt_id, attempt.id)
    item.repeat_request.report_id = 92
    await assert.rejects(execution.loadExecution(query, 'flanker'))
  } finally { h.restore() }
})
