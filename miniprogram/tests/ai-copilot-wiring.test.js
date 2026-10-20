const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const pages = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages
const formal = ['cognitive', 'stroop', 'flanker', 'nback', 'digit-span', 'trail']
const localHelp = ['login', 'register', 'server-settings', 'research-consent',
  'care-attention', 'service-coverage', 'responsibility-transfers', 'transferred-work']

for (const page of pages) {
  const key = page.split('/')[1]
  test(`${key} declares and renders its real companion with applicable safety guards`, () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, page + '.json'), 'utf8'))
    const wxml = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8')
    if (key === 'agent-chat') {
      assert.equal(config.usingComponents['ai-mascot'], '/components/ai-mascot/index')
      assert.match(wxml, /<ai-mascot\b[^>]*id="chat-pet"/)
      assert.doesNotMatch(wxml, /<ai-copilot\b/)
      return
    }
    assert.equal(config.usingComponents['ai-copilot'], '/components/ai-copilot/index')
    const tags = wxml.match(/<ai-copilot\b[^>]*\/>/g) || []
    assert.equal(tags.length, 1, 'exactly one floating companion per page')
    const tag = tags[0]
    assert.ok(tag.includes(`page-key="${key === 'workspace' ? '{{companionPageKey}}' : key}"`))
    if (formal.includes(key)) {
      assert.ok(tag.includes(`wx:if="{{!instructionVisible && !submitting && (phase === 'intro' || phase === 'result')}}"`))
      assert.ok(tag.includes(key === 'trail' ? `paused="{{running || phase === 'transition'}}"` : `paused="{{running}}"`))
    }
    if (['home', 'doctor-home', 'doctor-guide-settings', 'privacy-settings'].includes(key)) {
      assert.ok(tag.includes('wx:if="{{!onboardingVisible}}"'))
    }
    if (key === 'tracking') assert.ok(tag.includes('wx:if="{{!noteFocused && !submitting}}"'))
    if (key === 'patient-messages') assert.ok(tag.includes('wx:if="{{!inputFocused && !sending}}"'))
    if (key === 'doctor-patient') assert.ok(tag.includes('wx:if="{{!inputFocused && !sending && !creatingTask}}"'))
    if (localHelp.includes(key)) assert.ok(tag.includes('local-help-only="{{true}}"'), 'help must preserve this form and work without a login')
    if (['home', 'workspace', 'doctor-home'].includes(key)) assert.ok(tag.includes('bottom-inset="{{60}}"'))
    if (key === 'workspace' || key === 'doctor-patient') assert.ok(tag.includes('patient-id="{{patientId}}"'))
  })
}
