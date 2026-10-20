const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./rendering-browser-harness.cjs');
let harness;
before(async () => { harness = await start(); });
after(async () => { await harness?.close(); });
const attack = '<img src=x onerror="window.__xss=1">';
const session = { id: 42, patient_id: 8, source: 'self', status: 'active', version: 1,
    responsible_doctor_id: null, demonstration_only: true, background: { sleep: { status: 'provided', value: attack, source: 'self_report' } },
    items: [{ id: 9, title: attack, execution_status: 'not_started', quality_status: 'pending_validation', acceptance_status: 'not_required', attempts: [] }] };
async function openPage({ blocked = false, delayed = false, selfAllowed = true, emptyList = false } = {}) {
    const page = await harness.page('patient-web/patient_assessments.html', null);
    await page.evaluate(({ session, blocked, delayed, selfAllowed, emptyList }) => {
        localStorage.setItem('smartbrain_token', 'synthetic-assessment-A');
        localStorage.setItem('smartbrain_user', JSON.stringify({ id: 3, role: 'patient', patient_profile: { id: 8 } }));
        window.__assessmentWrites = [];
        window.API.Authorization = { getContext: async () => ({ accessible_patients: [{ patient_id: 8, display_name: 'Synthetic', patient_type: 'adult' }] }) };
        window.API.Assessment = {
            getTemplates: async () => ({ items: [{ id: 'adult-demo', version: 'W03-demo-1', title: 'Synthetic', admission_status: blocked ? 'blocked' : 'test_only', can_create: !blocked, can_create_self: selfAllowed && !blocked, can_create_doctor_assigned: !selfAllowed && !blocked, demonstration_only: true }] }),
            list: async () => ({ items: emptyList ? [] : [session] }), get: async () => session,
            createSelf: async body => { window.__assessmentWrites.push(body); return delayed ? new Promise(resolve => { window.__acknowledgeAssessment = resolve; }) : session; }
        };
    }, { session, blocked, delayed, selfAllowed, emptyList });
    const root = path.resolve(__dirname, '../..');
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'patient-web/js/session-guard.js'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'doctor-web/js/assessment-page.js'), 'utf8') });
    if (emptyList) await page.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('已读取'));
    else await page.waitForSelector('[data-assessment-id="42"]');
    return page;
}
test('actual assessment renderer keeps server states separate and displays hostile evidence as text', async () => {
    const page = await openPage();
    try {
        await page.click('[data-assessment-id="42"]');
        await page.waitForFunction(() => document.querySelector('#assessmentDetails').textContent.includes('无需医生验收'));
        const dom = await page.$eval('#assessmentDetails', node => ({ text: node.textContent, injected: node.querySelectorAll('img,script,svg,[onerror]').length }));
        assert.ok(dom.text.includes(attack)); assert.equal(dom.injected, 0);
        assert.equal(await page.evaluate(() => window.__xss), 0);
        assert.ok(dom.text.includes('未开始') && dom.text.includes('待验证'));
        assert.ok(!dom.text.includes('医生已验收'));
    } finally { await page.close(); }
});
test('formal admission blockers disable assessment creation in the actual page', async () => {
    const page = await openPage({ blocked: true });
    try {
        assert.equal(await page.$eval('#createAssessmentButton', node => node.disabled), true);
        assert.deepEqual(await page.evaluate(() => window.__assessmentWrites), []);
    } finally { await page.close(); }
});

test('actual self page cannot borrow a doctor-only creation hint', async () => {
    const page = await openPage({ selfAllowed: false });
    try {
        assert.equal(await page.$eval('#createAssessmentButton', node => node.disabled), true);
        assert.deepEqual(await page.evaluate(() => window.__assessmentWrites), []);
    } finally { await page.close(); }
});

test('a persisted new assessment is immediately available in the actual saved assessment list', async () => {
    const page = await openPage({ emptyList: true });
    try {
        await page.click('#createAssessmentButton');
        await page.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('本轮评估已保存'));
        assert.equal(await page.$eval('#assessmentList', node => node.textContent.includes('暂无可访问')), false);
        assert.ok(await page.$('[data-assessment-id="42"]'));
    } finally { await page.close(); }
});
test('late assessment acknowledgement cannot restore A evidence after B signs in', async () => {
    const page = await openPage({ delayed: true });
    try {
        await page.click('#createAssessmentButton');
        await page.waitForFunction(() => typeof window.__acknowledgeAssessment === 'function');
        await page.evaluate(session => {
            localStorage.setItem('smartbrain_token', 'synthetic-assessment-B');
            localStorage.setItem('smartbrain_user', JSON.stringify({ id: 4, role: 'patient', patient_profile: { id: 9 } }));
            window.dispatchEvent(new StorageEvent('storage', { key: 'smartbrain_token' }));
            window.__acknowledgeAssessment(session);
        }, session);
        await page.waitForSelector('[data-session-invalid="true"]');
        assert.equal(await page.evaluate(() => document.body.textContent.includes('<img src=x')), false);
        assert.equal(await page.$('#assessmentDetails'), null);
    } finally { await page.close(); }
});
