const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./rendering-browser-harness.cjs');
const root = path.resolve(__dirname, '../..');
let harness;
after(async () => { await harness?.close(); });
const attack = '<img src=x onerror="window.__xss=1">';
const attention = { id: 10, patient_id: 8, assessment_id: 42, submission_id: 's-1', source_event_id: 88,
    kind: 'assessment_quality', owner_kind: 'patient_self', responsible_doctor_id: null, relationship_id: null,
    status: 'open', version: 1, quality_reasons: [attack], response_coverage: { status: 'not_configured' },
    allowed_actions: ['read_evidence'], assessment_version: 3, expected_response_at: null };
const ack = { submission_id: 's-1', patient_id: 8, assessment_id: 42, execution_status: 'submitted',
    quality_status: 'limited', acceptance_status: 'pending_review', quality_reasons: [attack], committed_at: '2026-10-14T04:00:00Z' };
const evidence = { submission_id: 's-1', context: { patient_id: 8, assessment_id: 42 }, ack,
    server_result: { kind: 'scale', legacy: false, total_score: 0, score_json: { answers: [0, 0], note: attack } },
    client_evidence: { answers: [0, 0], note: attack }, storage_integrity: { status: 'authenticated' }, demonstration_only: true };
const record = { patient_id: 8, cycle_id: 6, record_date: '2026-10-13', revision: 2, recorded_at: null, legacy: false,
    submitted_at: '2026-10-14T04:00:00Z', is_backfill: true, submission_status: 'committed', content: { focus_minutes: 0, note: attack } };
const cycle = { id: 6, patient_id: 8, cycle_type: 'self', responsible_doctor_id: null, plan_version_id: null,
    start_date: '2026-10-13', end_date: '2026-10-26', calendar_timezone: 'Asia/Shanghai',
    processing_status: 'suspended', suspension_reason: 'original_authorization_replaced', allowed_actions: [],
    summary: { due_count: 3, completed_count: 1, missing_dates: ['2026-10-14', '2026-10-15'], coverage: 1 / 3, as_of_date: '2026-10-15' }, records: [record] };

test('entry pages load the shared readonly workbench with a live status region', () => {
    for (const file of ['patient-web/patient_care.html', 'doctor-web/doctor_care.html']) {
        assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist`);
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        assert.match(source, /care-workbench\.js/); assert.match(source, /role="status"/);
    }
});

async function open({ doctor = false, mismatch = false, delayEvidence = false, delayAttention = false,
    foreignOwner = false, inaccessible = false, fail = false, guardian = false } = {}) {
    harness ||= await start();
    const page = await harness.page(doctor ? 'doctor-web/doctor_care.html' : 'patient-web/patient_care.html', null);
    await page.evaluate(({ doctor, guardian }) => {
        localStorage.setItem('smartbrain_token', 'synthetic-w05-A');
        localStorage.setItem('smartbrain_user', JSON.stringify({ id: 3, role: doctor ? 'researcher' : 'patient', patient_profile: doctor || guardian ? null : { id: 8 } }));
        window.SMARTBRAIN_API_BASE_URL = `${location.origin}/api/v1`;
        if (guardian) history.replaceState({}, '', '?patient_id=8');
    }, { doctor, guardian });
    const calls = [], pending = {};
    page.removeAllListeners('request');
    page.on('request', request => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/v1/')) return request.abort();
        calls.push({ path: url.pathname + url.search, method: request.method() });
        const send = (data, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
        if (url.pathname.endsWith('/identity/context')) return send({ accessible_patients: inaccessible ? [] : [{ patient_id: 8, display_name: '合成档案', patient_type: 'adult' }] });
        if (url.pathname.endsWith('/attention') || url.pathname.endsWith('/work_queue')) {
            const item = doctor ? { ...attention, owner_kind: 'doctor', responsible_doctor_id: foreignOwner ? 99 : 3, relationship_id: 5 } : attention;
            const payload = { items: [item], service_coverage: { status: 'not_configured' } };
            if (delayAttention) { pending.attention = () => send(payload); return; }
            return fail ? send({ detail: 'Synthetic critical audit unavailable' }, 503) : send(payload);
        }
        if (url.pathname.endsWith('/evidence')) {
            const payload = mismatch ? { ...evidence, ack: { ...ack, patient_id: 9 } } : evidence;
            if (delayEvidence) { pending.evidence = () => send(payload); return; }
            return send(payload);
        }
        if (url.pathname.endsWith('/daily-history')) return send({ items: [{ ...record, revision: 1, content: { focus_minutes: 2 } }, record] });
        if (url.pathname.endsWith('/cycles/6')) return send(cycle);
        if (url.pathname.endsWith('/cycles')) return send({ items: [cycle], as_of_date: '2026-10-15', calendar_timezone: 'Asia/Shanghai' });
        return send({ detail: `Unexpected path: ${url.pathname}` }, 500);
    });
    for (const file of [(doctor ? 'doctor-web' : 'patient-web') + '/js/session-guard.js',
        (doctor ? 'doctor-web' : 'patient-web') + '/js/api.js', 'doctor-web/js/care-workbench.js']) {
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), 'utf8') });
    }
    return { page, calls, pending };
}
const loaded = page => page.waitForFunction(() => document.querySelector('#careMessage').textContent.includes('已读取'));
test('real renderer and API preserve hostile evidence, zero score, independent states and unconfigured coverage', async () => {
    const { page, calls } = await open();
    try {
        await loaded(page); await page.click('[data-evidence-id="s-1"]');
        await page.waitForFunction(() => document.querySelector('#careEvidence').textContent.includes('待医生验收'));
        const dom = await page.$eval('#careEvidence', node => ({ text: node.textContent, attacks: node.querySelectorAll('img,script,svg,[onerror]').length }));
        assert.ok(dom.text.includes(attack)); assert.equal(dom.attacks, 0); assert.equal(await page.evaluate(() => window.__xss), 0);
        assert.match(dom.text, /已提交/); assert.match(dom.text, /有局限/); assert.doesNotMatch(dom.text, /医生已验收/);
        assert.match(dom.text, /总分：0 分/); assert.match(await page.$eval('#careCoverage', n => n.textContent), /未配置/);
        assert.equal(await page.$eval('#careEvidence details', n => n.open), false);
        assert.ok(calls.some(x => x.path === '/api/v1/care/submissions/s-1/evidence')); assert.ok(calls.every(x => x.method === 'GET'));
        assert.equal(await page.evaluate(() => Object.keys(localStorage).some(k => k.includes('owned') || k.includes('evidence') || k.includes('cycle'))), false);
    } finally { await page.close(); }
});
test('cycle detail shows actual dates, server coverage, missing days, unknown original time and revision history', async () => {
    const { page } = await open();
    try {
        await loaded(page); await page.click('[data-cycle-id="6"]');
        await page.waitForSelector('[data-history-date="2026-10-13"]');
        const text = await page.$eval('#careCycleDetails', n => n.textContent);
        for (const value of ['2026-10-14', '2026-10-15', 'Asia/Shanghai', '33.3%', '未知', '已暂停', '补录', '修订 2']) assert.ok(text.includes(value), value);
        assert.match(text, /专注时长：0 分钟/);
        assert.equal(await page.$eval('#careCycleDetails details', n => n.open), false);
        await page.click('[data-history-date="2026-10-13"]');
        await page.waitForFunction(() => document.querySelector('#careHistory').textContent.includes('修订 1'));
        assert.match(await page.$eval('#careHistory', n => n.textContent), /修订 2/);
    } finally { await page.close(); }
});
test('doctor queue rejects another owner and never requests personal cycles', async () => {
    const { page, calls } = await open({ doctor: true, foreignOwner: true });
    try {
        await page.waitForFunction(() => document.querySelector('#careMessage').textContent.includes('不一致'));
        assert.equal(await page.$('[data-evidence-id]'), null); assert.equal(calls.some(x => x.path.includes('/cycles')), false);
    } finally { await page.close(); }
});
test('doctor assessment action honestly links the patient assessment list', async () => {
    const { page } = await open({ doctor: true });
    try {
        await loaded(page);
        assert.equal(await page.$eval('[data-assessment-link]', n => n.getAttribute('href')), 'doctor_assessments.html?patient_id=8');
        assert.match(await page.$eval('[data-assessment-link]', n => n.textContent), /列表/);
    } finally { await page.close(); }
});
test('evidence context mismatch fails closed and clears the detail', async () => {
    const { page } = await open({ mismatch: true });
    try {
        await loaded(page); await page.click('[data-evidence-id="s-1"]');
        await page.waitForFunction(() => document.querySelector('#careMessage').textContent.includes('不一致'));
        assert.equal(await page.$eval('#careEvidence', n => n.textContent), '');
    } finally { await page.close(); }
});
test('a late old account response never restores private evidence', async () => {
    const { page, pending } = await open({ delayEvidence: true });
    try {
        await loaded(page); await page.click('[data-evidence-id="s-1"]');
        await page.waitForFunction(() => document.querySelector('#careMessage').textContent.includes('正在'));
        await page.evaluate(() => {
            localStorage.setItem('smartbrain_token', 'synthetic-w05-B');
            localStorage.setItem('smartbrain_user', JSON.stringify({ id: 4, role: 'patient', patient_profile: { id: 9 } }));
            window.dispatchEvent(new StorageEvent('storage', { key: 'smartbrain_token' }));
        });
        await pending.evidence?.(); await page.waitForSelector('[data-session-invalid="true"]');
        assert.equal(await page.evaluate(attack => document.body.textContent.includes(attack), attack), false);
        assert.equal(await page.evaluate(() => localStorage.getItem('smartbrain_token')), 'synthetic-w05-B');
    } finally { await page.close(); }
});
test('pagehide clears every private view and stale operation cannot repaint it', async () => {
    const { page, pending } = await open({ delayEvidence: true });
    try {
        await loaded(page); await page.click('[data-evidence-id="s-1"]');
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await pending.evidence?.();
        assert.equal(await page.$eval('#careShell', n => n.textContent.includes('s-1')), false);
        assert.equal(await page.$eval('#careAttention', n => n.childElementCount), 0);
        assert.equal(await page.$eval('#careCycles', n => n.childElementCount), 0);
    } finally { await page.close(); }
});
test('guardian reads only explicitly selected accessible context and audit failure shows no evidence', async () => {
    const { page, calls } = await open({ guardian: true, fail: true });
    try {
        await page.waitForFunction(() => document.querySelector('#careMessage').textContent.includes('Synthetic critical audit unavailable'));
        assert.ok(calls.some(x => x.path === '/api/v1/care/patient/attention?patient_id=8'));
        assert.equal(await page.$('[data-evidence-id]'), null);
    } finally { await page.close(); }
});
test('unavailable identity context never borrows an ambient patient profile', async () => {
    const { page, calls } = await open({ inaccessible: true });
    try {
        await page.waitForFunction(() => document.querySelector('#careMessage').textContent.includes('获准'));
        assert.equal(calls.some(x => x.path.includes('/care/')), false);
    } finally { await page.close(); }
});
