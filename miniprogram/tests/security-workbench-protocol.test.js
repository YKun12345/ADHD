const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// A minimal DOM exercises the actual workbench event handlers without source-code assertions.
const nodes = new Map()
function makeNode(tag = 'div') {
  const node = { tag, style: {}, dataset: {}, children: [], _value: '', textContent: '',
    classList: { add() {}, remove() {} },
    appendChild(child) { this.children.push(child); if (this.tag === 'select' && this.children.length === 1) this._value = child.value },
    replaceChildren() { this.children = []; this._value = '' },
    addEventListener(event, callback) { this[event] = callback } }
  Object.defineProperty(node, 'options', { get() { return this.children.filter(child => child.tag === 'option') } })
  Object.defineProperty(node, 'value', { get() { return this._value }, set(value) { this._value = String(value) } })
  Object.defineProperty(node, 'innerHTML', { get() { return this._html || '' }, set(value) {
    this._html = value; this.children = []; this._input = undefined
    const input = value.match(/<input[^>]*value="(\d+)"([^>]*)>/)
    if (input) this._input = { value: input[1], checked: /\bchecked\b/.test(input[2]), disabled: /\bdisabled\b/.test(input[2]) }
  } })
  return node
}
let start
const document = { createElement: makeNode, addEventListener(event, callback) { if (event === 'DOMContentLoaded') start = callback },
  getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode(id.endsWith('Select') ? 'select' : 'div')); return nodes.get(id) },
  querySelectorAll() { return nodes.get('spatialPatientList').children.map(node => node._input).filter(input => input?.checked && !input.disabled) }
}
const web = 'cognitive:trail|patient_web|patient-web-preview-v1|1|unspecified'
const mobile = 'cognitive:trail|miniprogram|continuous-mobile-v4|6|adult'
const patient = (id, groups) => ({ patient_id: id, patient_name: 'P-' + id, security_overview: { audit_groups: { cognitive: groups } } })
const patients = [patient(1, [web, mobile]), patient(2, [mobile]), patient(3, [web])]
const calls = []
const result = kind => ({ id: 1, task_type: kind, source_type: 'cognitive', verification_passed: true,
  verification_details: { audit_group: mobile, record_count: kind === 'spatial' ? 2 : 1 }, decrypted_stats: { stats: {} } })
const Security = {
  async getSystemStatus() { return { is_initialized: true, profiles: {} } },
  async getAuditPatients() { return { items: patients } },
  async getKeyAssignments() { return { items: [] } }, async getMcsNodes() { return { items: [] } },
  async getPatientAssignments() { return { items: [] } }, async getRecentAudits() { return [] },
  async getAuditLogs() { return { items: [] } }, async getPatientCipherRecords() { return { items: [] } },
  async runTemporalAudit(payload) { calls.push(['temporal', payload]); return result('temporal') },
  async runSpatialAudit(payload) { calls.push(['spatial', payload]); return result('spatial') }
}
const context = vm.createContext({ document, console, window: { API: { Security } }, localStorage: {
  getItem() { return JSON.stringify({ role: 'researcher', subrole: 'dac', full_name: 'reviewer' }) }
}, Date })
document.getElementById('auditSourceTypeSelect').value = 'cognitive'
document.getElementById('spatialSourceTypeSelect').value = 'cognitive'
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../doctor-web/js/dac_dashboard.js'), 'utf8'), context)
;(async () => {
  await start()
  assert.equal(nodes.get('auditGroupSelect').options.length, 2)
  assert.equal(nodes.get('spatialAuditGroupSelect').options.length, 2)
  assert.deepEqual(document.querySelectorAll().map(input => Number(input.value)), [1, 3])
  nodes.get('spatialAuditGroupSelect').value = mobile
  nodes.get('spatialAuditGroupSelect').change()
  assert.deepEqual(document.querySelectorAll().map(input => Number(input.value)), [1, 2], 'different protocols cannot remain selected together')
  nodes.get('auditGroupSelect').value = mobile
  await nodes.get('runAuditBtn').click()
  assert.equal(calls[0][1].audit_group, mobile, 'temporal action must send the selected protocol')
  await nodes.get('runSpatialAuditBtn').click()
  assert.equal(calls[1][1].audit_group, mobile, 'spatial action must send the selected protocol')
  assert.deepEqual(Array.from(calls[1][1].patient_ids), [1, 2])
  assert.match(nodes.get('spatialAuditResultBox').innerHTML, /小程序/, 'audit results must identify the selected protocol')
  console.log('审计工作台协议选择、患者隔离和请求传递测试通过')
})().catch(error => { console.error(error); process.exitCode = 1 })
