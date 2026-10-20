const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, ready, loadInline } = require('./rendering-browser-harness.cjs');
let harness;
before(async () => { harness = await start(); });
after(async () => { await harness?.close(); });
const source = file => fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');

test('actual inline doctor priority summary cannot count unshared evidence as missing or complete', async () => {
    const page = await harness.page('doctor-web/doctor_patients.html', null, { patients: [{ patient_id: 7001,
        patient_name: null, allowed_scope: ['care'], latest_scale_type: null, latest_scale_risk_level: null,
        completed_tracking_days: null, cognitive_test_count: null }] });
    try {
        await loadInline(page, 'doctor-web/doctor_patients.html');
        await ready(page);
        const suggestion = await page.$eval('#aiAssistantSuggestion', node => node.textContent);
        assert.ok(!suggestion.includes('null') && !suggestion.includes('需补') && !suggestion.includes('已完成'), suggestion);
        assert.equal(await page.$eval('#statHighRisk', node => node.textContent), '未共享');
        assert.equal(await page.$eval('#statPending', node => node.textContent), '未共享');
        assert.equal(await page.$eval('#statComplete', node => node.textContent), '未共享');
        const list = await page.$eval('#aiPriorityList', node => node.textContent);
        assert.ok(list.includes('共享档案 #7001'), list);
        assert.ok(!list.includes('补 量表') && !list.includes('基础评估完整'), list);
        await page.evaluate(() => analyzeAndRender([{ patient_id: 7002, patient_name: '合成完整资料',
            allowed_scope: ['profile', 'assessment', 'tracking', 'care', 'imaging'], latest_scale_type: 'ASRS',
            latest_scale_risk_level: 'low', completed_tracking_days: 14, cognitive_test_count: 1 }]));
        assert.equal(await page.$eval('#statPending', node => node.textContent), '0');
        assert.equal(await page.$eval('#statComplete', node => node.textContent), '1');
        assert.ok((await page.$eval('#aiPriorityList', node => node.textContent)).includes('已共享基础资料完整'));
    } finally { await page.close(); }
});

test('doctor relationship panel labels redacted subjects without rendering null', async () => {
    const page = await harness.page('doctor-web/doctor_profile.html', null);
    try {
        await page.evaluate(() => {
            localStorage.setItem('smartbrain_token', 'synthetic-panel-token');
            window.API.Authorization = {
                getContext: async () => ({ user_id: 9001, identities: [], accessible_patients: [] }),
                getRelationships: async () => ({ items: [{ id: 3, patient_id: 7001, patient_name: null,
                    counterparty_email: 'synthetic-known@example.org', status: 'pending', initiator_user_id: 9001,
                    scope: ['care'], revision: 1 }] })
            };
        });
        await page.addScriptTag({ content: source('doctor-web/js/session-guard.js') });
        await page.addScriptTag({ content: source('doctor-web/js/authorization-panel.js') });
        await page.waitForSelector('[data-relationship-id="3"]');
        const text = await page.$eval('[data-relationship-id="3"]', node => node.textContent);
        assert.ok(!text.includes('null') && text.includes('共享档案 #7001'), text);
    } finally { await page.close(); }
});

test('doctor workbench labels care-only redacted fields as unshared in actual Chrome', async () => {
    const page = await harness.page('doctor-web/doctor_patients.html', 'doctor-web/js/doctor_patients.js', {
        patients: [{ patient_id: 7001, patient_name: null, patient_email: null, patient_type: null,
            allowed_scope: ['care'], completed_tracking_days: null, current_tracking_day: null, cognitive_test_count: null,
            latest_scale_type: null, latest_scale_risk_level: null, latest_scale_total_score: null, has_imaging: null }]
    });
    try {
        await ready(page);
        const text = await page.$eval('#myPatientList', node => node.textContent);
        assert.ok(text.includes('共享档案 #7001'), text);
        assert.ok(text.includes('评估未共享'), text);
        assert.ok(text.includes('跟踪未共享'), text);
        assert.ok(text.includes('影像未共享'), text);
        assert.ok(!text.includes('待补充') && !text.includes('待进入影像处理'), text);
    } finally { await page.close(); }
});

test('assessment-only doctor report shows a stable subject label and unshared profile marker', async () => {
    const page = await harness.page('doctor-web/doctor_report.html', null);
    try {
        await page.evaluate(() => {
            history.replaceState({}, '', '?patient_id=7001');
            localStorage.setItem('smartbrain_token', 'synthetic-scope-token');
            window.API.Doctor.getPatientReportDetails = async () => ({ patient_id: 7001, allowed_scope: ['assessment'],
                patient_name: null, patient_email: null, patient_type: null,
                latest_scale: { id: 1, scale_type: 'ASRS', respondent_type: 'self', total_score: 72,
                    risk_level: 'high', summary: '合成量表摘要', recommendations: [], radar_scores: {}, sub_scores: {} },
                care_summary: [], suggested_actions: [], cognitive_profile: null, tracking_summary: null,
                tracking_logs: null, latest_imaging_visualization: null, latest_model_prediction: null });
        });
        await page.addScriptTag({ content: source('doctor-web/js/session-guard.js') });
        await page.addScriptTag({ content: source('doctor-web/js/doctor_report.js') });
        await ready(page);
        await page.waitForFunction(() => document.querySelector('#patientTitle').textContent.includes('综合报告'));
        const title = await page.$eval('#patientTitle', node => node.textContent);
        assert.ok(title.includes('共享档案 #7001'), title);
        assert.ok((await page.$eval('#patientSubTitle', node => node.textContent)).includes('基础资料未共享'));
        assert.ok((await page.$eval('#reportContent', node => node.textContent)).includes('72'));
    } finally { await page.close(); }
});

test('doctor analysis invitation waits for the recipient and does not navigate as if bound', async () => {
    const page = await harness.page('doctor-web/doctor_analysis.html', null);
    try {
        await page.evaluate(() => {
            localStorage.setItem('smartbrain_token', 'synthetic-invitation-token');
            window.__invitationCalls = [];
            window.API.Doctor.getDashboardStats = async () => ({ patient_count: 0, pending_imaging_count: 0, weekly_report_count: 0 });
            window.API.Doctor.bindPatientByEmail = async body => {
                window.__invitationCalls.push(body); return { id: 1, patient_id: 7001, status: 'pending', patient_name: null };
            };
            window.API.Authorization = { invite: async body => {
                window.__invitationCalls.push(body); return { id: 1, patient_id: 7001, status: 'pending', patient_name: null };
            } };
        });
        await page.addScriptTag({ content: source('doctor-web/js/session-guard.js') });
        await page.addScriptTag({ content: source('doctor-web/js/doctor_home.js') });
        await ready(page);
        const originalUrl = page.url();
        await page.click('#openBindModalBtn');
        await page.type('#bindModalEmailInput', 'synthetic-owner@example.com');
        await page.click('#confirmBindPatientBtn');
        await page.waitForFunction(() => document.querySelector('#bindModalFeedback').textContent.length > 0);
        assert.match(await page.$eval('#bindModalFeedback', node => node.textContent), /等待对方确认/);
        await new Promise(resolve => setTimeout(resolve, 750));
        assert.equal(page.url(), originalUrl);
        assert.deepEqual(await page.evaluate(() => window.__invitationCalls[0].scope), ['profile', 'assessment', 'tracking', 'care', 'imaging']);
    } finally { await page.close(); }
});
