// Independent, bounded W05 quality checks. Production markup/API/guard/renderer
// and CSS run in real Chrome; every HTTP payload below is explicitly synthetic.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { start } = require('./rendering-browser-harness.cjs');
const root = path.resolve(__dirname, '../..');
let harness;
after(async () => { await harness?.close(); });

const submissionId = 'quality-synthetic-original-37d888f0-1616-4646-b349-' + '1234567890'.repeat(6);
const attention = { id: 71, patient_id: 8, assessment_id: 42, submission_id: submissionId,
    source_event_id: 301, kind: 'assessment_quality', owner_kind: 'patient_self',
    responsible_doctor_id: null, relationship_id: null, status: 'open', version: 3,
    assessment_version: 4, quality_reasons: ['unknown_input'], expected_response_at: null,
    response_coverage: { status: 'not_configured' }, allowed_actions: ['read_evidence'] };
const record = (cycleId, date, note, revision = 1) => ({ patient_id: 8, cycle_id: cycleId,
    record_date: date, revision, legacy: false, recorded_at: null,
    submitted_at: '2026-10-03T02:00:00', is_backfill: true,
    submission_status: 'committed', content: { focus_minutes: 0, note } });
const cycle = (id, note) => ({ id, patient_id: 8, cycle_type: 'self', responsible_doctor_id: null,
    plan_version_id: null, start_date: '2026-10-01', end_date: '2026-10-03',
    calendar_timezone: 'Asia/Shanghai', processing_status: 'suspended',
    suspension_reason: 'original_authority_invalid',
    summary: { due_count: 3, completed_count: 2, coverage: 2 / 3, as_of_date: '2026-10-03',
        missing_dates: ['2026-10-03'] },
    records: [record(id, '2026-10-01', `${note}-day-one`), record(id, '2026-10-02', `${note}-day-two`)] });
const cycles = [cycle(81, 'first-cycle'), cycle(82, 'second-cycle')];
const evidence = { submission_id: submissionId, context: { patient_id: 8, assessment_id: 42 },
    ack: { submission_id: submissionId, patient_id: 8, assessment_id: 42,
        execution_status: 'submitted', quality_status: 'limited', quality_reasons: ['unknown_input'],
        acceptance_status: 'not_required', assessment_status: 'closed_self', assessment_version: 4,
        committed_at: '2026-10-03T02:00:00' },
    server_result: { kind: 'scale', legacy: false, scale_type: 'ASRS', total_score: 0,
        score_json: { answers: [0, 0] } },
    client_evidence: { note: 'SYNTHETIC-PRIVATE-ORIGINAL', raw_only: 'SYNTHETIC-RAW-ONLY' },
    demonstration_only: true };

async function open(options = {}) {
    harness ||= await start();
    const page = await harness.page('patient-web/patient_care.html', null);
    await page.setViewport({ width: 390, height: 844 });
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'doctor-web/css/care-workbench.css'), 'utf8') });
    await page.evaluate(() => {
        localStorage.setItem('smartbrain_token', 'synthetic-independent-quality');
        localStorage.setItem('smartbrain_user', JSON.stringify({ id: 3, role: 'patient', patient_profile: { id: 8 } }));
        window.SMARTBRAIN_API_BASE_URL = `${location.origin}/api/v1`;
    });
    const calls = [], deferred = new Map(), counts = new Map();
    page.removeAllListeners('request');
    page.on('request', request => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/v1/')) return request.abort();
        const key = url.pathname + url.search;
        const count = (counts.get(key) || 0) + 1;
        counts.set(key, count); calls.push({ path: key, method: request.method() });
        const send = (data, status = 200) => request.respond({ status,
            contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
        if (url.pathname.endsWith('/identity/context')) return send({ user_id: 3,
            accessible_patients: [{ patient_id: 8, display_name: '合成质量复核档案' }] });
        if (url.pathname.endsWith('/attention')) return options.failRefresh && count > 1
            ? send({ detail: 'Synthetic current access denied' }, 403)
            : send({ items: [attention], service_coverage: { status: 'not_configured' } });
        if (url.pathname.endsWith('/evidence')) {
            if (options.deferSecondEvidence && count > 1) { deferred.set('evidence', () => send(evidence)); return; }
            return send(evidence);
        }
        if (url.pathname.endsWith('/daily-history')) {
            const date = url.searchParams.get('record_date');
            const id = Number(url.pathname.split('/').at(-2));
            const rows = [record(id, date, `${date}-history-first`), record(id, date, `${date}-history-latest`, 2)];
            if (options.deferFirstHistory && date === '2026-10-01') { deferred.set('history', () => send({ items: rows })); return; }
            return send({ items: rows });
        }
        if (url.pathname.endsWith('/cycles/81') && options.deferFirstCycle) {
            deferred.set('cycle', () => send({ detail: 'Synthetic old cycle audit failure' }, 503)); return;
        }
        const selected = cycles.find(item => url.pathname.endsWith(`/cycles/${item.id}`));
        if (selected) return send(selected);
        if (url.pathname.endsWith('/cycles')) return send({ items: cycles });
        return send({ detail: `Unexpected synthetic quality route ${url.pathname}` }, 500);
    });
    for (const file of ['patient-web/js/session-guard.js', 'patient-web/js/api.js', 'doctor-web/js/care-workbench.js']) {
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), 'utf8') });
    }
    await page.waitForFunction(() => document.getElementById('careMessage').textContent === '已读取当前获准资料。');
    return { page, calls, deferred };
}
const settled = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const privateText = page => page.evaluate(() => ['careAttention', 'careCycles', 'careEvidence', 'careCycleDetails', 'careHistory']
    .map(id => document.getElementById(id).textContent).join(''));

test('both production CareWorkflow groups expose only the same seven encoded GET routes', () => {
    const argumentsByMethod = { getContext: [], getPatientAttention: ['8&other=9'], getDoctorQueue: [],
        getEvidence: ['source/part?x=#'], getCycles: ['8&other=9'], getCycle: ['81/82'],
        getDailyHistory: ['81/82', '2026-10-01&other=1'] };
    const expected = ['/identity/context', '/care/patient/attention?patient_id=8%26other%3D9',
        '/care/doctor/work_queue', '/care/submissions/source%2Fpart%3Fx%3D%23/evidence',
        '/care/cycles?patient_id=8%26other%3D9', '/care/cycles/81%2F82',
        '/care/cycles/81%2F82/daily-history?record_date=2026-10-01%26other%3D1'];
    for (const side of ['patient-web', 'doctor-web']) {
        const source = fs.readFileSync(path.join(root, side, 'js/api.js'), 'utf8');
        const group = source.match(/CareWorkflow:\s*(\{[\s\S]*?\n    \}),/);
        assert.ok(group, `${side} current CareWorkflow group`);
        const calls = [];
        const api = vm.runInNewContext(`(${group[1]})`, { request: (route, options) => calls.push({ route, method: options.method }), encodeURIComponent });
        assert.deepEqual(Object.keys(api), Object.keys(argumentsByMethod));
        Object.entries(argumentsByMethod).forEach(([name, args]) => api[name](...args));
        assert.deepEqual(calls.map(call => call.route), expected);
        assert.ok(calls.every(call => call.method === 'GET'));
    }
});

test('an earlier failed cycle response cannot erase the later selected real cycle', async () => {
    const { page, deferred } = await open({ deferFirstCycle: true });
    try {
        await page.click('[data-cycle-id="81"]');
        await page.waitForFunction(() => document.getElementById('careMessage').textContent.includes('正在读取真实日期'));
        await page.click('[data-cycle-id="82"]');
        await page.waitForFunction(() => document.getElementById('careCycleDetails').textContent.includes('second-cycle-day-one'));
        await deferred.get('cycle')(); await settled(page);
        const text = await page.$eval('#careCycleDetails', element => element.innerText);
        assert.match(text, /自助周期 #82/); assert.match(text, /66\.7%/);
        assert.match(text, /原授权或身份关系已失效，旧安排已暂停/);
        assert.doesNotMatch(text, /first-cycle|original_authority_invalid|Synthetic old cycle/);
    } finally { await page.close(); }
});

test('a late earlier date history cannot replace the selected date or its immutable revisions', async () => {
    const { page, deferred } = await open({ deferFirstHistory: true });
    try {
        await page.click('[data-cycle-id="81"]');
        await page.waitForSelector('[data-history-date="2026-10-02"]');
        await page.click('[data-history-date="2026-10-01"]');
        await page.waitForFunction(() => document.getElementById('careMessage').textContent.includes('正在读取日期修订'));
        await page.click('[data-history-date="2026-10-02"]');
        await page.waitForFunction(() => document.getElementById('careHistory').textContent.includes('2026-10-02-history-latest'));
        await deferred.get('history')(); await settled(page);
        const text = await page.$eval('#careHistory', element => element.innerText);
        assert.match(text, /2026-10-02 的不可变修订历史/);
        assert.match(text, /修订 1/); assert.match(text, /修订 2/);
        assert.doesNotMatch(text, /2026-10-01-history/);
        assert.equal(await page.$$eval('#careHistory details', nodes => nodes.length === 2 && nodes.every(node => !node.open)), true);
    } finally { await page.close(); }
});

test('long source identifiers and raw originals stay collapsed without narrow-screen overflow', async () => {
    const { page, calls } = await open();
    try {
        assert.equal(calls.some(call => call.path.endsWith('/evidence')), false);
        assert.equal(await page.$eval('#careAttention details', element => element.open), false);
        assert.equal((await page.$eval('#careAttention', element => element.innerText)).includes(submissionId), false);
        await page.$eval('[data-evidence-id]', element => element.click());
        await page.waitForFunction(() => document.getElementById('careEvidence').textContent.includes('SYNTHETIC-PRIVATE-ORIGINAL'));
        assert.equal(await page.$eval('#careEvidence details', element => element.open), false);
        assert.doesNotMatch(await page.$eval('#careEvidence', element => element.innerText), /SYNTHETIC-RAW-ONLY/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.$eval('#careAttention summary', element => element.click());
        assert.match(await page.$eval('#careAttention', element => element.innerText), new RegExp(submissionId));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.ok(calls.every(call => call.method === 'GET'));
    } finally { await page.close(); }
});

test('denied refresh clears all previously loaded private panels and invalidates a late original', async () => {
    const { page, deferred } = await open({ failRefresh: true, deferSecondEvidence: true });
    try {
        await page.$eval('[data-evidence-id]', element => element.click());
        await page.waitForFunction(() => document.getElementById('careEvidence').textContent.includes('SYNTHETIC-PRIVATE-ORIGINAL'));
        await page.click('[data-cycle-id="81"]'); await page.waitForSelector('[data-history-date="2026-10-01"]');
        await page.click('[data-history-date="2026-10-01"]');
        await page.waitForFunction(() => document.getElementById('careHistory').textContent.includes('history-latest'));
        assert.equal(await page.evaluate(() => ['careAttention', 'careCycles', 'careEvidence', 'careCycleDetails', 'careHistory']
            .every(id => document.getElementById(id).textContent.length > 0)), true);
        await page.$eval('[data-evidence-id]', element => element.click());
        await page.waitForFunction(() => document.getElementById('careMessage').textContent.includes('正在读取原提交'));
        await page.click('#careRefresh');
        await page.waitForFunction(() => document.getElementById('careMessage').textContent.includes('权限不足或网络异常'));
        await deferred.get('evidence')(); await settled(page);
        assert.equal(await privateText(page), '');
        assert.equal(await page.$eval('#careCoverage', element => element.textContent), '');
        assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('SYNTHETIC-PRIVATE')), false);
    } finally { await page.close(); }
});
