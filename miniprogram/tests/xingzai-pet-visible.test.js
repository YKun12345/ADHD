const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { createHarness } = require('./helpers/cognitive-harness')
test('a visible touch control drives the actual mascot without sending or changing the business state', async () => {
  const h = createHarness()
  try {
    h.setRequest(async options => {
      if (options.url.startsWith('/agent/context?')) return { actor_user_id: 7, patient_id: 8, assessments: [] }
      if (options.url.startsWith('/agent/runs?')) return { actor_user_id: 7, patient_id: 8, items: [] }
      if (options.url.startsWith('/agent/actions?')) return { actor_user_id: 7, patient_id: 8, items: [] }
      throw new Error(options.url)
    })
    const page = h.load('agent-chat', { query: { patient_id: '8' } }); await page._loadPromise
    let touched = 0
    page.selectComponent = selector => { assert.equal(selector, '#chat-pet'); return { onInteract() { touched++; page.petXingzai({ detail: { accepted: true, reaction: 'wave' } }) } } }
    assert.equal(page.touchXingzai(), true)
    assert.equal(touched, 1); assert.match(page.data.petText, /挥手/)
    assert.equal(page.data.petState, 'idle')
    page.petXingzai({ detail: { accepted: false, reaction: '' } }); assert.match(page.data.petText, /处理/)
    page.onInput({ detail: { value: '输入时陪着我' } }); assert.equal(page.data.petState, 'listening')
    page.onInput({ detail: { value: '' } }); assert.equal(page.data.petState, 'idle')
    assert.equal(h.requests.some(row => row.method === 'POST'), false)
    page.onHide(); assert.equal(page.touchXingzai(), false)
  } finally { h.restore() }
})
test('the interactive mascot and touch button stay with the fixed composer after the conversation scrolls', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/agent-chat/index.wxml'), 'utf8')
  const composerStart = wxml.search(/<view class="composer(?:\s[^"]*)?"/)
  assert.ok(composerStart >= 0, 'the composer remains present after visual classes are added')
  const composer = wxml.slice(composerStart)
  assert.match(composer, /id="chat-pet"/)
  assert.match(composer, /bindtap="touchXingzai"/)
  assert.match(composer, /摸摸星仔/)
  assert.equal((wxml.match(/id="chat-pet"/g) || []).length, 1)
})
