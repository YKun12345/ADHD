const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, ready } = require('./rendering-browser-harness.cjs');
let harness;
after(async () => { await harness?.close(); });
for (const [role, file, script] of [['patient', 'patient-web/patient_report.html', 'patient-web/js/report.js'],
    ['doctor', 'doctor-web/doctor_report.html', 'doctor-web/js/doctor_report.js']]) {
    test(`${role} real report initialization shows pending imaging storage instead of an empty report`, async () => {
        harness ||= await start();
        const page = await harness.page(file, script, { report: { imaging_history_status: 'storage_upgrade_required' } });
        try {
            await page.evaluate(() => {
                history.replaceState({}, '', '?patient_id=7001');
                window.API.Doctor.getPatientReportDetails = async () => ({ patient_id: 7001,
                    allowed_scope: ['assessment', 'imaging'], imaging_history_status: 'storage_upgrade_required' });
            });
            await ready(page);
            await page.waitForFunction(() => document.querySelector('#imagingHistoryStatus')?.textContent.includes('升级'));
            assert.equal(await page.$eval('#reportContent', node => node.classList.contains('hidden')), false);
            assert.match(await page.$eval('#imagingHistoryStatus', node => node.textContent), /存储.*升级/);
            assert.equal(await page.$eval('#imagingSection', node => node.classList.contains('hidden')), true);
            assert.equal(await page.$eval('#modelPredictionSection', node => node.classList.contains('hidden')), true);
        } finally { await page.close(); }
    });
    test(`${role} conversion and unknown storage status suppress old bodies and status clears on a subsequent ready view`, async () => {
        harness ||= await start(); const page = await harness.page(file, script);
        try {
            for (const [status, label] of [['conversion_required', /旧记录.*转换/], ['unknown_status', /状态.*核对/], ['not_authorized', /未共享/]]) {
                await page.evaluate(status => renderImagingHistory({ imaging_history_status: status,
                    latest_imaging_visualization: { visualization_type: 'slice', summary_text: '旧敏感正文' },
                    latest_model_prediction: { summary_text: '旧敏感模型', prediction_label: 'ADHD' } }), status);
                assert.match(await page.$eval('#imagingHistoryStatus', node => node.textContent), label);
                assert.equal(await page.$eval('#imagingSection', node => node.classList.contains('hidden')), true);
                assert.equal(await page.$eval('#modelPredictionSection', node => node.classList.contains('hidden')), true);
                assert.doesNotMatch(await page.$eval('#imagingSummary', node => node.textContent), /旧敏感/);
            }
            await page.evaluate(() => renderImagingHistory({ imaging_history_status: 'ready',
                latest_imaging_visualization: { visualization_type: 'slice', summary_text: '当前已认证记录' } }));
            assert.equal(await page.$eval('#imagingHistoryStatus', node => node.classList.contains('hidden')), true);
            assert.equal(await page.$eval('#imagingSummary', node => node.textContent), '当前已认证记录');
            await page.evaluate(() => renderImagingHistory({ imaging_history_status: 'no_records' }));
            assert.equal(await page.$eval('#imagingSection', node => node.classList.contains('hidden')), true);
            assert.doesNotMatch(await page.$eval('#imagingSummary', node => node.textContent), /当前已认证/);
        } finally { await page.close(); }
    });
}
