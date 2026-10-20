const test = require('node:test')
const assert = require('node:assert/strict')
const { presentRun } = require('../utils/xingzai-chat')

test('actual user background and cycle suggestions expose human review while ordinary answers keep their chat treatment', () => {
  assert.equal(presentRun({ intent: 'profile_fields' }, 'patient').canEditDraft, true)
  assert.equal(presentRun({ intent: 'cycle_summary' }, 'patient').canEditDraft, true)
  assert.equal(presentRun({ intent: 'question' }, 'patient').canEditDraft, false)
  assert.equal(presentRun({ intent: 'plan_draft' }, 'patient').canEditDraft, false)
})

test('adoption links preserve the exact actual cycle and separate new background assessment from old assessment IDs', () => {
  const { adoptionUrl, profileContent, profileRows } = require('../utils/agent-adoption')
  assert.equal(adoptionUrl({ target_type: 'cycle_review', patient_id: 8, cycle_id: 3, id: 7 }), '/pages/cycle-review/index?patient_id=8&cycle_id=3&ai_decision_id=7')
  assert.equal(adoptionUrl({ target_type: 'assessment_background', patient_id: 8, assessment_id: 99, id: 7 }), '/pages/assessments/index?patient_id=8&ai_decision_id=7')
  assert.equal(adoptionUrl({ target_type: 'cycle_review', patient_id: 8, id: 7 }), '')
  const content = { fields: { sleep: { status: 'unknown', value: null }, school_work: { status: 'provided', value: '实际输入' } } }
  const rows = profileRows(content)
  assert.deepEqual(profileContent(rows), content)
  assert.equal(rows.every(row => row.confirmed === false), true)
})
