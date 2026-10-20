const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHarness } = require('./helpers/cognitive-harness')

test('all four workspace sections expose their existing assistant context and keep the actual profile', async () => {
  const h = createHarness()
  try {
    h.setRequest(async options => {
      if (options.url === '/identity/context') return { accessible_patients: [{patient_id:8,display_name:'合成用户'}] }
      if (options.url === '/auth/me') return {id:7,role:'patient',full_name:'合成用户',email:'synthetic@example.com'}
      if (options.url.startsWith('/care/')) return {items:[]}
      if (options.url.startsWith('/agent/')) return {actor_user_id:7,patient_id:8,items:[]}
      throw Error(options.url)
    })
    for (const [section,key] of [['assessments','assessments'],['records','care-cycles'],['communication','shared-messages'],['account','privacy-settings']]) {
      const page=h.load('workspace',{query:{section}}); await page._loadPromise
      assert.equal(page.data.errorText,'')
      assert.equal(page.data.companionPageKey,key)
      assert.ok(page.data.entryItems.every(row => typeof row.icon === 'string'))
      if (section!=='account') assert.equal(page.data.patientId,8)
      page.onHide(); assert.equal(page.data.patientId,0)
    }
  } finally {h.restore()}
})

test('workspace mounts the real copilot and passes the actual patient without adding a second business route', () => {
  const dir=path.join(__dirname,'../pages/workspace')
  const config=JSON.parse(fs.readFileSync(path.join(dir,'index.json'),'utf8'))
  const wxml=fs.readFileSync(path.join(dir,'index.wxml'),'utf8')
  assert.equal(config.usingComponents['ai-copilot'],'/components/ai-copilot/index')
  assert.match(wxml,/<ai-copilot\b[^>]*patient-id="\{\{patientId\}\}"/)
  assert.match(wxml,/bindtap="openEntry"/)
})
