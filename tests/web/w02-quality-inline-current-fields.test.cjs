// Independent actual-HTML consumer verification. No business server or real data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { start, ready, loadInline } = require(path.resolve(__dirname, '../../tests/web/rendering-browser-harness.cjs'));
let harness;
before(async () => { harness = await start(); });
after(async () => { await harness?.close(); });
const complete = { patient_id: 9101, patient_name: 'Synthetic current DTO', patient_email: 'synthetic-current@example.org',
    allowed_scope: ['profile', 'assessment', 'tracking', 'care', 'imaging'], latest_scale_type: 'ASRS',
    latest_scale_risk_level: 'low', completed_tracking_days: 14, cognitive_test_count: 1,
    tracking_completed_days: 0, has_cognitive: false };

test('inline summary uses real current tracking/count fields rather than contradictory legacy aliases', async () => {
    const page = await harness.page('doctor-web/doctor_patients.html', null, { patients: [complete] });
    try {
        await loadInline(page, 'doctor-web/doctor_patients.html');
        await ready(page);
        assert.equal(await page.$eval('#statComplete', node => node.textContent), '1');
        assert.equal(await page.$eval('#statPending', node => node.textContent), '0');
        const list = await page.$eval('#aiPriorityList', node => node.textContent);
        assert.ok(list.includes('Synthetic current DTO'), list);
        assert.ok(list.includes('已共享基础资料完整'), list);
        assert.ok(!list.includes('补 认知测试') && !list.includes('追踪还差'), list);
    } finally { await page.close(); }
});

test('mixed visible and withheld evidence cannot turn withheld scope into a missing or completed path', async () => {
    const page = await harness.page('doctor-web/doctor_patients.html', null, { patients: [complete,
        { patient_id: 9102, patient_name: null, allowed_scope: ['care'], latest_scale_type: null,
            latest_scale_risk_level: null, completed_tracking_days: null, cognitive_test_count: null }] });
    try {
        await loadInline(page, 'doctor-web/doctor_patients.html');
        await ready(page);
        assert.equal(await page.$eval('#statComplete', node => node.textContent), '1');
        assert.equal(await page.$eval('#statPending', node => node.textContent), '0');
        const list = await page.$eval('#aiPriorityList', node => node.textContent);
        assert.ok(list.includes('共享档案 #9102') && list.includes('评估或跟踪未共享'), list);
        assert.ok(!list.includes('null') && !list.includes('补 量表') && !list.includes('追踪还差'), list);
        const suggestion = await page.$eval('#aiAssistantSuggestion', node => node.textContent);
        assert.ok(suggestion.includes('未共享') && !suggestion.includes('所有'), suggestion);
    } finally { await page.close(); }
});
