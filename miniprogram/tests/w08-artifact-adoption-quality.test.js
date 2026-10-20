// Independent real-controller checks with synthetic transport; no real HTTP claim.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

test('switching actual profile clears the previous profile editor, adoption and private decision history', async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    h.setRequest(async options => {
      if (options.url === '/doctor/my_patients') return { items: [{ patient_id: 8, patient_name: '合成甲' }, { patient_id: 9, patient_name: '合成乙' }] }
      const patientId = Number(new URL(options.url, 'https://synthetic.invalid').searchParams.get('patient_id'))
      if (options.url.startsWith('/agent/context?')) return { actor_user_id: 7, patient_id: patientId, assessments: [] }
      if (options.url.startsWith('/agent/runs?')) return { actor_user_id: 7, patient_id: patientId, items: [] }
      throw new Error('unexpected synthetic route: ' + options.url)
    })
    const page = h.load('agent-chat'); await page._loadPromise
    assert.equal(page.data.patientId, 8)
    page._editContext = { artifact_id: 18, patient_id: 8 }
    page.setData({ editor: { artifactId: 18 }, editorText: '甲档案的私有编辑正文', editorReason: '甲档案的人工原因',
      adoptedDecision: { id: 28, patient_id: 8, assessment_id: 38, target_type: 'shared_message' },
      decisionHistory: [{ id: 48, patient_id: 8, contentText: '甲档案的私有决定历史' }] })
    assert.equal(await page.selectProfile({ detail: { value: '1' } }), true)
    assert.equal(page.data.patientId, 9)
    assert.deepEqual({ editor: page.data.editor, text: page.data.editorText, reason: page.data.editorReason,
      adoption: page.data.adoptedDecision, history: page.data.decisionHistory, originalEditorContext: page._editContext },
      { editor: null, text: '', reason: '', adoption: null, history: [], originalEditorContext: null })
    assert.equal(h.requests.some(options => options.method === 'POST'), false)
  } finally { h.restore() }
})

function actualState() {
  const h = createHarness(); h.storage.current_user.role = 'researcher'
  const hash = 'a'.repeat(64)
  const run = { run_id: 11, actor_user_id: 7, patient_id: 8, status: 'completed', mode: 'rules', input_digest: hash,
    artifact: { id: 18, run_id: 11, actor_user_id: 7, patient_id: 8, status: 'draft', kind: 'reply_draft', stale: false,
      source_refs: ['assessment:31:2'], body: { reply: '合成甲档案材料', reply_draft: { text: '甲档案待核对正文' } } } }
  const ctx = { artifact_id: 18, actor_user_id: 7, patient_id: 8, input_digest: hash, kind: 'reply_draft', assessment_id: 31,
    default_content: { text: '甲档案待核对正文' }, allowed_decisions: ['adopt', 'edit', 'reject'] }
  const decision = { id: 28, actor_user_id: 7, patient_id: 8, assessment_id: 31, target_type: 'shared_message',
    artifact_id: 18, decision: 'adopt', content: { text: '甲档案待核对正文' }, reason: '甲档案实际原因' }
  let delayedAdoption
  h.setRequest(async options => {
    if (options.url === '/doctor/my_patients') return { items: [{ patient_id: 8, patient_name: '合成甲' }, { patient_id: 9, patient_name: '合成乙' }] }
    if (options.url === '/agent/artifacts/18/decision-context') return ctx
    if (options.url === '/agent/artifacts/18/decisions') return { artifact_id: 18, actor_user_id: 7, patient_id: 8, items: [decision] }
    if (options.url === '/agent/artifact-decisions/28/adoption-context') return delayedAdoption ? delayedAdoption() : decision
    const patientId = Number(new URL(options.url, 'https://synthetic.invalid').searchParams.get('patient_id'))
    if (options.url.startsWith('/agent/context?')) return { actor_user_id: 7, patient_id: patientId,
      assessments: patientId === 8 ? [31, 32].map(id => ({ id, responsible_doctor_id: 7, age_group: 'adult' })) : [] }
    if (options.url.startsWith('/agent/runs?')) return { actor_user_id: 7, patient_id: patientId, items: patientId === 8 ? [run] : [] }
    throw new Error('unexpected synthetic route: ' + options.url)
  })
  return { h, decision, delayAdoption(fn) { delayedAdoption = fn } }
}

for (const state of ['editor', 'adopted']) test('reachable ' + state + ' state clears when selecting a different actual profile', async () => {
  const { h, decision } = actualState()
  try {
    const page = h.load('agent-chat', { query: { assessment_id: '31' } }); await page._loadPromise
    assert.equal(await page.openEditor({ currentTarget: { dataset: { id: 18 } } }), true)
    assert.equal(await page.viewDecisions({ currentTarget: { dataset: { id: 18 } } }), true)
    if (state === 'adopted') assert.equal(await page.readyDecision(decision, page._epoch), true)
    assert.equal(state === 'editor' ? page.data.editorText : page.data.adoptedDecision.content.text, '甲档案待核对正文')
    await page.selectProfile({ detail: { value: '1' } })
    assert.equal(page.data.patientId, 9)
    assert.deepEqual([page.data.editor, page.data.adoptedDecision, page._editContext], [null, null, null])
    assert.deepEqual(page.data.decisionHistory, []); assert.equal(page.data.editorText, '')
    assert.equal(h.requests.some(options => options.method === 'POST'), false)
  } finally { h.restore() }
})

test('assessment change clears an opened editor and hides the previous adoption navigation', async () => {
  const { h, decision } = actualState()
  try {
    const page = h.load('agent-chat', { query: { assessment_id: '31' } }); await page._loadPromise
    await page.openEditor({ currentTarget: { dataset: { id: 18 } } }); await page.readyDecision(decision, page._epoch)
    assert.equal(page.data.adoptedDecision.id, 28)
    page.selectAssessment({ detail: { value: '2' } })
    assert.equal(page.data.assessmentId, 32); assert.equal(page.data.adoptedDecision, null)
    assert.equal(page.openDecision(), false); assert.equal(h.requests.some(options => options.method === 'POST'), false)
  } finally { h.restore() }
})

test('late adoption context cannot restore a hidden and reopened Agent page', async () => {
  const value = actualState(), { h, decision } = value
  try {
    const page = h.load('agent-chat', { query: { assessment_id: '31' } }); await page._loadPromise
    let release; value.delayAdoption(() => new Promise(resolve => { release = resolve }))
    const old = page.readyDecision(decision, page._epoch); await h.flush()
    page.onHide(); await page.onShow()
    release(decision); assert.equal(await old, false)
    assert.equal(page.data.adoptedDecision, null); assert.equal(page.data.editorText, '')
    assert.equal(page.openDecision(), false)
  } finally { h.restore() }
})
