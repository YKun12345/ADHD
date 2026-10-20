const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { tab, storage, signIn } = require('../../tests/web/session-harness.cjs')
const { buildLocalReport, mergeReport } = require('../utils/report-data')
const { attachProtocolMetadata } = require('../utils/cognitive-page-support')
const { getTaskConfig } = require('../utils/cognitive-config')

async function run() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../patient-web/js/patient_test_session.js'), 'utf8')
  const store = storage(); signIn(store, 1)
  const web = tab('patient-web', store)
  web.load('patient-web/js/owned-cache.js')
  const local = store.values
  const session = new Map()
  const submitted = []
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', children: [], classList: { add() {}, remove() {} }, scrollIntoView() {},
      append(...children) { this.children.push(...children) }, appendChild(child) { this.children.push(child) }, replaceChildren() { this.children = [] } })
    return elements.get(id)
  }
  const context = web.context
  Object.assign(context, {
    console, URLSearchParams, Date, Math, clearTimeout() {}, setTimeout() { return 1 },
    performance: { now: () => 500 },
    document: { getElementById: element, createElement: element, addEventListener() {} },
    sessionStorage: { getItem: key => session.get(key) || null, setItem: (key, value) => session.set(key, value) },
  })
  context.window.location.search = '?test=reaction'
  context.window.API.Patient.submitCognitiveTest = async payload => submitted.push(payload)
  vm.runInContext(source, context)
  assert.equal(vm.runInContext('getTestType()', context), 'simple_reaction', 'old reaction links must launch the correctly identified simple reaction')
  vm.runInContext("canvas={width:400,height:400}; clearCanvas=fillCanvasBackground=drawCircle=drawCenterText=()=>{}; schedule=()=>1; sessionState.testType=getTestType(); sessionState.running=true; startReactionTest(); for(let i=0;i<5;i++){sessionState.runtime.clickable=true; sessionState.runtime.startTime=200; canvasClickHandler();}", context)
  await Promise.resolve()
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].test_type, 'simple_reaction')
  const result = submitted[0].result_json
  assert.equal(result.source, 'patient_web')
  assert.equal(result.protocol_id, 'patient-web-preview-v1')
  assert.equal(result.protocol_schema_version, 1)
  assert.equal(result.age_group, 'unspecified')
  assert.equal(result.raw_result.completed_rounds, 5)
  const stored = JSON.parse([...local.entries()].find(([key]) => key.startsWith('smartbrain_owned_v1:'))[1])
  assert.equal(stored.value[0].protocol_id, result.protocol_id)
  assert.equal(stored.owner.accountId, 1)
  assert.equal(local.has('smartbrain_latest_cognitive_test'), false)
  assert.equal(web.window.OwnedCache.read(web.window.OwnedCache.achievementContext).gonogo_rt, undefined, 'simple reaction cannot unlock a Go/No-Go achievement')
  assert.equal(session.has('achievement_trigger'), false, 'anonymous achievement flags must never be created')

  const mobile = attachProtocolMetadata({ test_type: 'digit', result_json: { raw_result: {} } }, getTaskConfig('digit', 'adult'), 4)
  assert.equal(mobile.result_json.source, 'miniprogram')
  assert.equal(mobile.result_json.age_group, 'adult')

  const localReport = buildLocalReport({ cognitiveResults: { trail: { test_type: 'trail', result_json: {
    source: 'miniprogram', protocol_id: 'continuous-mobile-v4', protocol_schema_version: 6, age_group: 'adult',
    raw_result: { elapsed_ms: 90000, errors: 1 }, finished_at: '2026-10-10T08:00:00Z'
  } } } })
  const common = { test_type: 'trail', test_name: '连线测试', status_text: '已记录', key_metric: '总用时 5 秒' }
  const report = mergeReport(localReport, { cognitive_profile: { summary: '不同协议单独记录', latest_tests: [
    { ...common, source: 'patient_web', protocol_id: 'patient-web-preview-v1', protocol_schema_version: 1, age_group: 'unspecified', series_id: 'trail|patient_web|patient-web-preview-v1|1|unspecified' },
    { ...common, source: 'miniprogram', protocol_id: 'continuous-mobile-v4', protocol_schema_version: 6, age_group: 'adult', series_id: 'trail|miniprogram|continuous-mobile-v4|6|adult' },
    { ...common, test_type: 'simple_reaction', test_name: '简单反应时', source: 'patient_web', protocol_id: 'patient-web-preview-v1', protocol_schema_version: 1, age_group: 'unspecified', series_id: 'simple_reaction|patient_web|patient-web-preview-v1|1|unspecified' }
  ] } })
  assert.equal(report.cognitive.cards.length, 3, 'same task in different protocols must remain separately visible')
  assert.equal(new Set(report.cognitive.cards.map(card => card.seriesId)).size, 3)
  assert.equal(report.cognitive.completedCount, 1, 'preview simple reaction is separate from the six mobile tasks')
  assert.match(report.cognitive.cards.find(card => card.testType === 'simple_reaction').protocolText, /网页|patient-web-preview/)
  console.log('认知来源、协议分组与网页真实提交回归通过')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
