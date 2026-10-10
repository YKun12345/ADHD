const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const nodes = new Map()
function makeNode(tag = 'div') {
  const node = { tag, style: {}, children: [], classList: { add() {}, remove() {} },
    appendChild(child) { this.children.push(child); if (child.id) nodes.set(child.id, child) },
    addEventListener(event, callback) { this[event] = callback } }
  Object.defineProperty(node, 'innerHTML', { get() { return this._html || '' }, set(value) { this._html = value; this.children = [] } })
  return node
}
const document = { addEventListener() {}, createElement: makeNode, getElementById(id) {
  if (!nodes.has(id)) nodes.set(id, makeNode())
  return nodes.get(id)
} }
const rendered = []
const context = vm.createContext({ document, console, window: {}, localStorage: {}, Date })
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../patient-web/js/report.js'), 'utf8'), context)
context.captureRadar = scores => rendered.push(scores)
vm.runInContext("initRadarChart=(id,scores)=>captureRadar(scores); formatDateTime=()=>'';", context)
const group = (key, source, score) => ({
  protocol_key: key, source, protocol_id: source === 'patient_web' ? 'patient-web-preview-v1' : 'continuous-mobile-v4',
  protocol_label: source === 'patient_web' ? '网页简版' : '连续移动筛查版',
  protocol_schema_version: source === 'patient_web' ? 1 : 6, age_group: source === 'patient_web' ? 'unspecified' : 'adult',
  radar_scores: { working_memory: score }, summary: key + ' only',
  latest_tests: [{ test_name: key, test_type: 'digit', status_text: '已完成', key_metric: String(score) }]
})
const a = group('web', 'patient_web', 2)
const b = group('mobile', 'miniprogram', 12)
context.profile = { active_protocol_key: 'web', protocol_profiles: [a, b], latest_tests: [...a.latest_tests, ...b.latest_tests], radar_scores: a.radar_scores }
vm.runInContext('renderCognitiveSummary(profile)', context)
const selector = nodes.get('cognitiveProtocolSelect')
assert.ok(selector, 'protocol group selector must be visible')
assert.equal(nodes.get('cognitiveTests').children.length, 1, 'only the selected protocol renders in the radar view')
assert.equal(rendered[0].working_memory, 2)
selector.value = 'mobile'
selector.change()
assert.equal(nodes.get('cognitiveTests').children.length, 1)
assert.equal(nodes.get('cognitiveSummary').textContent, 'mobile only')
assert.equal(rendered.at(-1).working_memory, 12)
console.log('网页认知协议分组切换与雷达隔离测试通过')
