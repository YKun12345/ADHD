const assert = require('node:assert/strict')
const { start, ready } = require('../../tests/web/rendering-browser-harness.cjs')

// Exercise the actual workbench and SafeRender in Chrome's real DOM. Only the
// API responses are synthetic; protocol controls and handlers are production code.
const web = 'cognitive:trail|patient_web|patient-web-preview-v1|1|unspecified'
const mobile = 'cognitive:trail|miniprogram|continuous-mobile-v4|6|adult'
const patient = (id, groups) => ({ patient_id: id, patient_name: 'P-' + id,
  security_overview: { audit_groups: { cognitive: groups } } })
const patients = [patient(1, [web, mobile]), patient(2, [mobile]), patient(3, [web])]

;(async () => {
  const harness = await start()
  try {
    const page = await harness.page('doctor-web/dac_dashboard.html', 'doctor-web/js/dac_dashboard.js')
    await page.evaluate(({ patients, mobile }) => {
      localStorage.setItem('smartbrain_user', JSON.stringify({ id: 9001, role: 'researcher', subrole: 'dac', full_name: 'Synthetic reviewer' }))
      window.__protocolCalls = []
      const result = kind => ({ id: 1, task_type: kind, source_type: 'cognitive', verification_passed: true,
        verification_details: { audit_group: mobile, record_count: kind === 'spatial' ? 2 : 1 }, decrypted_stats: { stats: {} } })
      Object.assign(window.API.Security, {
        async getSystemStatus() { return { is_initialized: true, profiles: {} } },
        async getAuditPatients() { return { items: patients } },
        async getKeyAssignments() { return { items: [] } }, async getMcsNodes() { return { items: [] } },
        async getPatientAssignments() { return { items: [] } }, async getRecentAudits() { return [] },
        async getAuditLogs() { return { items: [] } }, async getPatientCipherRecords() { return { items: [] } },
        async runTemporalAudit(payload) { window.__protocolCalls.push(['temporal', payload]); return result('temporal') },
        async runSpatialAudit(payload) { window.__protocolCalls.push(['spatial', payload]); return result('spatial') }
      })
      document.getElementById('auditSourceTypeSelect').value = 'cognitive'
      document.getElementById('spatialSourceTypeSelect').value = 'cognitive'
    }, { patients, mobile })
    await ready(page)
    assert.equal(await page.$eval('#auditGroupSelect', node => node.options.length), 2)
    assert.equal(await page.$eval('#spatialAuditGroupSelect', node => node.options.length), 2)
    const selectedIds = () => page.$$eval('.spatial-patient-checkbox:checked', nodes => nodes.map(node => Number(node.value)))
    assert.deepEqual(await selectedIds(), [1, 3])
    await page.evaluate(mobile => {
      const select = document.getElementById('spatialAuditGroupSelect')
      select.value = mobile; select.dispatchEvent(new Event('change'))
    }, mobile)
    assert.deepEqual(await selectedIds(), [1, 2], 'different protocols cannot remain selected together')
    assert.equal(await page.$eval('.spatial-patient-checkbox[value="3"]', node => node.disabled), true)
    await page.evaluate(mobile => {
      document.getElementById('auditGroupSelect').value = mobile
      document.getElementById('runAuditBtn').click()
    }, mobile)
    await page.waitForFunction(() => window.__protocolCalls.length === 1 && !document.getElementById('runAuditBtn').disabled)
    let calls = await page.evaluate(() => window.__protocolCalls)
    assert.equal(calls[0][0], 'temporal')
    assert.equal(calls[0][1].audit_group, mobile, 'temporal action must send the selected protocol')
    assert.equal(calls[0][1].patient_id, 1)
    await page.evaluate(() => document.getElementById('runSpatialAuditBtn').click())
    await page.waitForFunction(() => window.__protocolCalls.length === 2 && !document.getElementById('runSpatialAuditBtn').disabled)
    calls = await page.evaluate(() => window.__protocolCalls)
    assert.equal(calls[1][0], 'spatial')
    assert.equal(calls[1][1].audit_group, mobile, 'spatial action must send the selected protocol')
    assert.deepEqual(calls[1][1].patient_ids, [1, 2])
    assert.match(await page.$eval('#spatialAuditResultBox', node => node.textContent), /小程序/, 'audit results must identify the selected protocol')
    console.log('审计工作台协议选择、患者隔离和请求传递测试通过（真实 SafeRender / Chrome DOM）')
  } finally {
    await harness.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
