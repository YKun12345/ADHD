const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { start, ready, rendered, loadInline } = require('./rendering-browser-harness.cjs');
let harness;
before(async () => { harness = await start(); });
after(async () => { if (harness) await harness.close(); });
const attack = '<img src=x onerror="window.__xss=1"><svg onload="window.__xss=1"></svg>';
async function plain(page, selector, text) {
    const result = await rendered(page, selector);
    assert.equal(result.injected, 0, `Untrusted markup in ${selector}: ${result.html}`);
    assert.ok(result.text.includes(text), `Literal text absent in ${selector}`);
    assert.equal(await page.evaluate(() => window.__xss), 0);
}

test('doctor priority inline renderer preserves API name, email and risk as literal text', async () => {
    const file = 'doctor-web/doctor_patients.html';
    const page = await harness.page(file, null);
    await loadInline(page, file);
    await page.evaluate(attack => analyzeAndRender([{ patient_id: 7101, patient_name: attack,
        patient_email: attack, latest_scale_risk_level: attack }]), attack);
    await plain(page, '#aiPriorityList', attack);
    const href = await page.$eval('#aiPriorityList a', node => node.getAttribute('href'));
    assert.ok(href.includes('focus_patient_id=7101')); await page.close();
});

test('clinical pathway inline renderer preserves report chip fields as literal text', async () => {
    const file = 'patient-web/clinical_pathway.html';
    const page = await harness.page(file, null, { report: { latest_scale: { scale_type: attack, risk_level: attack,
        total_score: 4 }, imaging_analysis: { prediction_label: attack, confidence_level: attack } } });
    await loadInline(page, file); await ready(page);
    await page.waitForSelector('.pathway-card');
    await plain(page, '#pathwayTimeline', attack);
    assert.ok(await page.$$eval('.pathway-card', nodes => nodes.length) >= 8); await page.close();
});

test('report action advice handles typed counts and malformed string counts without executable markup', async () => {
    const file = 'patient-web/patient_report.html';
    const page = await harness.page(file, null); await loadInline(page, file);
    await page.evaluate(attack => renderActionAdvice({ latest_scale: { risk_level: 'high' },
        tracking_summary: { completed_count: attack, total_days: 14 } }), attack);
    const invalid = await rendered(page, '#actionAdviceList');
    assert.equal(invalid.injected, 0);
    assert.ok(invalid.text.includes('建议补充认知测试'));
    await page.evaluate(() => renderActionAdvice({ latest_scale: { risk_level: 'high' },
        tracking_summary: { completed_count: 3, total_days: 14 } }));
    assert.ok((await rendered(page, '#actionAdviceList')).text.includes('当前 3/14 天'));
    await page.close();
});

async function dacPage(data = {}) {
    const page = await harness.page('doctor-web/dac_dashboard.html', 'doctor-web/js/dac_dashboard.js');
    await page.evaluate(data => {
        // Current backend uses pseudonyms. These fixtures deliberately retain those
        // pseudonyms; attacks target other unconstrained API text fields only.
        localStorage.setItem('smartbrain_user', JSON.stringify({ id: 9001, role: 'researcher', subrole: 'dac', full_name: 'Synthetic DAC' }));
        Object.assign(window.API.Security, {
            getSystemStatus: async () => ({ is_initialized: true, system_version: data.systemVersion || 'v1', storage_mode: 'synthetic',
                key_assignment_count: 1, mcs_node_count: 1, patient_assignment_count: 1, cipher_record_count: 1, audit_task_count: 1 }),
            getAuditPatients: async () => ({ items: data.patients || [{ patient_id: 7101, patient_name: 'PAT-7101', security_overview: { audit_groups: { tracking: ['tracking:v1'] } } }] }),
            getKeyAssignments: async () => ({ items: [{ full_name: 'PAT-7101', email: '身份信息已隔离', role: 'patient', key_fingerprint: data.fingerprint || 'synthetic-fingerprint' }] }),
            getMcsNodes: async () => ({ items: [{ node_name: data.nodeName || 'Synthetic MCS', node_code: 'MCS-1', storage_backend: 'synthetic', storage_namespace: 'synthetic' }] }),
            getPatientAssignments: async () => ({ items: [{ patient_name: 'PAT-7101', patient_id: 7101, assigned_dac_name: 'DAC-9001', assignment_status: 'active', assigned_mcs_node_code: 'MCS-1' }] }),
            getRecentAudits: async () => data.audits || [], getAuditLogs: async () => ({ items: data.logs || [] }),
            getPatientCipherRecords: async () => ({ items: data.ciphers || [] }),
            runTemporalAudit: async () => { window.__auditRequested = true; if (data.error) throw new Error(data.error); return data.auditResult; },
            runSpatialAudit: async () => data.auditResult
        });
    }, data);
    await ready(page); return page;
}

test('DAC audit log message is rendered literally at the API boundary', async () => {
    const page = await dacPage({ logs: [{ id: 1, action: 'data_read', status: 'success', message: attack, created_at: '2026-10-13T00:00:00' }] });
    await plain(page, '#recentLogList', attack); await page.close();
});

test('DAC error response is rendered literally after actual audit button action', async () => {
    const page = await dacPage({ error: attack });
    await page.evaluate(() => document.getElementById('runAuditBtn').click());
    await page.waitForFunction(() => window.__auditRequested && !document.getElementById('runAuditBtn').disabled);
    await plain(page, '#auditResultBox', attack); await page.close();
});

test('DAC MCS descriptive fields and key fingerprint are rendered literally', async () => {
    const page = await dacPage({ nodeName: attack, fingerprint: attack });
    await plain(page, '#mcsNodeTableBody', attack); await plain(page, '#keyAssignmentTableBody', attack); await page.close();
});

test('DAC cipher metadata strings are rendered literally', async () => {
    const page = await dacPage({ ciphers: [{ id: 1, time_bucket: '2026-10-13', source_type: 'tracking',
        metadata: { evidence_version: attack }, mcs_node_id: 1 }] });
    await plain(page, '#cipherRecordTableBody', attack); await page.close();
});

test('DAC audit card renders verification issues and metric labels literally while keeping numeric charts', async () => {
    const audit = { id: 1, task_type: 'temporal', source_type: 'tracking', status: 'completed', verification_passed: true,
        verification_details: { audit_group: 'tracking:v1', issues: [attack] },
        decrypted_stats: { record_count: 1, stats: { [attack]: { sum: 3, average: 3, variance: 0 } } } };
    const page = await dacPage({ audits: [audit], auditResult: audit });
    await plain(page, '#recentAuditList', attack);
    await page.evaluate(() => document.getElementById('runAuditBtn').click());
    await page.waitForSelector('#auditResultBox .result-card');
    await plain(page, '#auditResultBox', attack);
    assert.equal(await page.$$eval('#auditResultBox .result-mini-fill', nodes => nodes.length), 3); await page.close();
});

test('DAC system status strings are rendered literally', async () => {
    const page = await dacPage({ systemVersion: attack });
    await plain(page, '#systemStatusText', attack); await page.close();
});

test('DAC spatial controls and result panels preserve pseudonyms and selected patient IDs', async () => {
    const patients = [7101, 7102].map(patient_id => ({ patient_id, patient_name: `PAT-${patient_id}`,
        security_overview: { audit_groups: { tracking: ['tracking:v1'] } } }));
    const auditResult = { id: 2, task_type: 'spatial', source_type: 'tracking', status: 'completed', verification_passed: true,
        verification_details: { audit_group: 'tracking:v1', issues: [attack] },
        decrypted_stats: { record_count: 2, aggregated_patient_ids: [7101], missing_patient_ids: [7102], stats: {} } };
    const page = await dacPage({ patients, auditResult });
    assert.deepEqual(await page.$$eval('.spatial-patient-checkbox:checked', nodes => nodes.map(node => node.value)), ['7101', '7102']);
    await page.evaluate(() => document.getElementById('runSpatialAuditBtn').click());
    await page.waitForSelector('#spatialAuditResultBox .result-card');
    await plain(page, '#spatialAuditResultBox', attack);
    assert.deepEqual(await page.$$eval('#spatialAuditResultBox .result-person-tag', nodes => nodes.map(node => node.textContent)),
        ['PAT-7101（#7101）', 'PAT-7102（#7102）']); await page.close();
});
