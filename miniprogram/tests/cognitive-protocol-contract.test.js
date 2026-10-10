const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { buildLocalReport, mergeReport } = require('../utils/report-data')
const { attachProtocolMetadata } = require('../utils/cognitive-page-support')
const { getTaskConfig } = require('../utils/cognitive-config')

async function run() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../patient-web/js/patient_test_session.js'), 'utf8')
  const local = new Map()
  const session = new Map()
  const submitted = []
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', classList: { add() {}, remove() {} }, scrollIntoView() {} })
    return elements.get(id)
  }
  const context = vm.createContext({
    console, URLSearchParams, Date, Math, clearTimeout() {}, setTimeout() { return 1 },
    performance: { now: () => 500 },
    document: { getElementById: element, addEventListener() {} },
    localStorage: { getItem: key => local.get(key) || null, setItem: (key, value) => local.set(key, value) },
    sessionStorage: { getItem: key => session.get(key) || null, setItem: (key, value) => session.set(key, value) },
    window: { location: { search: '?test=reaction' }, API: { Patient: { submitCognitiveTest: async payload => submitted.push(payload) } } }
  })
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
  assert.equal(JSON.parse(local.get('smartbrain_latest_cognitive_test')).protocol_id, result.protocol_id)
  assert.equal(JSON.parse(session.get('achievement_trigger')).gonogo_rt, undefined, 'simple reaction cannot unlock a Go/No-Go achievement')

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
