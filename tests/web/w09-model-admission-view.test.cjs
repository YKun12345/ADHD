const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, ready } = require('./rendering-browser-harness.cjs');
let harness;
after(async () => { await harness?.close(); });
const attack = '<img src=x onerror="window.__xss=1">';
async function open(mode = 'real', { deferred = false, status = 'unverified', permitted = false } = {}) {
    harness ||= await start();
    const page = await harness.page('doctor-web/doctor_imaging.html', 'doctor-web/js/main.js', { patients: [{ patient_id: 7001, patient_name: '合成资料' }] });
    await page.evaluate(({ mode, deferred, attack, status, permitted }) => {
        localStorage.setItem('smartbrain_selected_patient_id', '7001');
        window.__calls = [];
        window.API.Model = { getAdmission: async () => {
            window.__calls.push('admission');
            const result = { inference_mode: mode, status, real_inference_allowed: permitted,
                message: status === 'legacy_accepted' ? '沿用原有旧权重，训练来源未重新核验' : '来源尚未通过准入 ' + attack };
            if (deferred) return new Promise(resolve => { window.__releaseAdmission = () => resolve(result); });
            return result;
        } };
        window.API.Doctor.predictTimeseries = async () => {
            window.__calls.push('POST');
            return { prediction_id: 1, source_type: 'mock', is_demo: true, probability: .8, probability_control: .2,
                file_name: 'synthetic.csv', model_name: 'DemoMock', model_version: 'synthetic', summary_text: attack };
        };
    }, { mode, deferred, attack, status, permitted });
    return page;
}
const select = page => page.evaluate(() => {
    const input = document.getElementById('timeseriesFileInput'), files = new DataTransfer();
    files.items.add(new File(['1,2'], 'synthetic.csv')); input.files = files.files; input.dispatchEvent(new Event('change'));
});
for (const status of ['legacy_accepted', 'admitted']) test(`actual page accepts backend ${status} only with explicit permission`, async () => {
    const page = await open('real', { status, permitted: true });
    try {
        await ready(page); await select(page);
        assert.equal(await page.$eval('#generateReportBtn', node => node.disabled), false);
        assert.match(await page.$eval('#generateReportBtn', node => node.textContent), /开始分类推理/);
        if (status === 'legacy_accepted') assert.match(await page.$eval('#modelAdmissionStatus', node => node.textContent), /旧权重.*未重新核验/);
    } finally { await page.close(); }
});
test('actual imaging page displays unverified source literally and disables new real inference, including a dispatched click', async () => {
    const page = await open();
    try {
        await ready(page); await select(page);
        assert.equal(await page.$eval('#generateReportBtn', node => node.disabled), true);
        assert.match(await page.$eval('#generateReportBtn', node => node.textContent), /待准入/);
        assert.match(await page.$eval('#modelAdmissionStatus', node => node.textContent), /未通过准入/);
        assert.match(await page.$eval('#modelAdmissionStatus', node => node.textContent), /<img/);
        await page.evaluate(() => document.getElementById('generateReportBtn').dispatchEvent(new Event('click')));
        assert.equal((await page.evaluate(() => window.__calls)).includes('POST'), false);
        assert.equal(await page.$eval('#modelAdmissionStatus', node => node.querySelectorAll('img').length), 0);
        assert.equal(await page.evaluate(() => window.__xss), 0);
    } finally { await page.close(); }
});
test('explicit mock mode remains visibly demonstration output and does not invent calibrated confidence', async () => {
    const page = await open('mock');
    try {
        await ready(page); await select(page);
        assert.equal(await page.$eval('#generateReportBtn', node => node.disabled), false);
        assert.match(await page.$eval('#modelAdmissionStatus', node => node.textContent), /演示/);
        await page.click('#generateReportBtn');
        await page.waitForFunction(() => document.getElementById('predictionStatusBadge').textContent.includes('演示'));
        assert.match(await page.$eval('#predictionSummary', node => node.textContent), /演示/);
        assert.match(await page.$eval('#connectivityStatusBadge', node => node.textContent), /未计算|不计算/);
        assert.doesNotMatch(await page.$eval('#predictionMeta', node => node.textContent), /高置信|中等置信|低置信/);
        assert.equal(await page.evaluate(() => window.__xss), 0);
    } finally { await page.close(); }
});
test('a model status response arriving after hiding the actual page cannot reenable inference or restore a dossier', async () => {
    const page = await open('mock', { deferred: true });
    try {
        const waiting = ready(page);
        await page.waitForFunction(() => typeof window.__releaseAdmission === 'function');
        await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); window.__releaseAdmission(); });
        await waiting;
        assert.equal(await page.$eval('#generateReportBtn', node => node.disabled), true);
        assert.doesNotMatch(await page.$eval('#timeseriesPatientMeta', node => node.textContent), /合成资料|7001/);
        assert.equal((await page.evaluate(() => window.__calls)).includes('POST'), false);
    } finally { await page.close(); }
});
