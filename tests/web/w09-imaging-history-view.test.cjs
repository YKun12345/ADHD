const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./rendering-browser-harness.cjs');
let harness;
after(async () => { await harness?.close(); });
for (const [role, file, script] of [['patient', 'patient-web/patient_report.html', 'patient-web/js/report.js'],
    ['doctor', 'doctor-web/doctor_report.html', 'doctor-web/js/doctor_report.js']]) {
    test(`${role} existing historical model view keeps missing probability unknown and does not invent calibrated confidence or approval`, async () => {
        harness ||= await start(); const page = await harness.page(file, script);
        try {
            await page.evaluate(() => renderModelPredictionSummary({ prediction_id: 10, prediction_label: 'Control', probability: .95,
                probability_control: null, source_type: 'fmri_hgst', model_name: '合成旧模型', source_admission_status: 'not_recorded',
                professional_review_status: 'not_recorded', version_status: 'legacy_unversioned' }));
            assert.equal(await page.$eval('#modelPredictionControlValue', node => node.textContent), '--');
            assert.equal(await page.$eval('#modelPredictionConfidence', node => node.textContent), '未提供校准置信度');
            const meta = await page.$eval('#modelPredictionMeta', node => node.textContent);
            assert.match(meta, /准入.*未记录/); assert.match(meta, /审核.*未记录/); assert.match(meta, /未.*不可变.*版本/);
        } finally { await page.close(); }
    });
    test(`${role} explicit historical demonstration stays visible as demonstration`, async () => {
        harness ||= await start(); const page = await harness.page(file, script);
        try {
            await page.evaluate(() => renderModelPredictionSummary({ prediction_id: 10, prediction_label: 'ADHD', probability: .8,
                probability_control: .2, source_type: 'mock', is_demo: true, source_admission_status: 'demonstration_only' }));
            assert.match(await page.$eval('#modelPredictionBadge', node => node.textContent), /演示/);
            assert.match(await page.$eval('#modelPredictionMeta', node => node.textContent), /演示.*不用于临床/);
        } finally { await page.close(); }
    });
}
