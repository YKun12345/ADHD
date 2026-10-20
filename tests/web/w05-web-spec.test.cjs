// Independent W05 web specification checks. Real Chrome and production page/API/
// SessionGuard/renderer source; the HTTP responses below are explicitly synthetic.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./rendering-browser-harness.cjs');
const root = path.resolve(__dirname, '../..');
let harness;
after(async () => { await harness?.close(); });

const clone = value => structuredClone(value);
const item = (submission = 'spec-original-A', overrides = {}) => ({
    id: submission.endsWith('B') ? 102 : 101, patient_id: 8, assessment_id: 42,
    submission_id: submission, source_event_id: 201, kind: 'assessment_quality',
    owner_kind: 'patient_self', responsible_doctor_id: null, relationship_id: null,
    status: 'open', version: 7, assessment_version: 4, expected_response_at: null,
    quality_reasons: ['unknown_input'], response_coverage: { status: 'not_configured' },
    allowed_actions: ['read_evidence'], ...overrides,
});
const evidence = (submission = 'spec-original-A', overrides = {}) => ({
    submission_id: submission,
    context: { patient_id: 8, assessment_id: 42 },
    ack: { submission_id: submission, patient_id: 8, assessment_id: 42,
        execution_status: 'submitted', quality_status: 'limited', quality_reasons: ['unknown_input'],
        acceptance_status: 'not_required', assessment_status: 'closed_self', assessment_version: 4,
        committed_at: '2026-10-15T16:45:31.504072' },
    // Shape follows submission_service.get_evidence and the actual temporary-HTTP
    // receipt: metrics live in result_json.raw_result, not result_json's root.
    server_result: { kind: 'cognitive', id: 901, test_type: 'flanker', legacy: false,
        result_json: { actual_trials: 24, summary: '正确率 100%',
            raw_result: { accuracy: 100, total_trials: 24, correct_trials: 24,
                average_reaction_time_ms: 100, omissions: 0, conflict_effect_ms: 0 } } },
    client_evidence: { note: `saved-${submission}`, synthetic_raw_only: 'RAW-DETAILS-ONLY' },
    storage_integrity: { format: 'aesgcm:v2', status: 'authenticated', data_version: 1 },
    authorization_snapshot: { synthetic_internal_only: 'AUTH-SNAPSHOT-ONLY' },
    demonstration_only: true, ...overrides,
});
const cycle = { id: 61, patient_id: 8, cycle_type: 'self', responsible_doctor_id: null,
    plan_version_id: null, start_date: '2026-10-01', end_date: '2026-10-03',
    calendar_timezone: 'Asia/Shanghai', processing_status: 'active',
    summary: { as_of_date: '2026-10-03', completed_count: 1, due_count: 3,
        coverage: 1 / 3, missing_dates: ['2026-10-02', '2026-10-03'] },
    records: [{ patient_id: 8, cycle_id: 61, record_date: '2026-10-01', revision: 2,
        legacy: false, recorded_at: null, submitted_at: '2026-10-03T01:00:00',
        is_backfill: true, submission_status: 'committed', content: { focus_minutes: 0, note: 'date-one' } }] };

async function open(options = {}) {
    harness ||= await start();
    const doctor = Boolean(options.doctor);
    const side = doctor ? 'doctor-web' : 'patient-web';
    const page = await harness.page(`${side}/${doctor ? 'doctor' : 'patient'}_care.html`, null);
    await page.evaluate(({ doctor, query }) => {
        localStorage.setItem('smartbrain_token', 'synthetic-independent-spec-A');
        localStorage.setItem('smartbrain_user', JSON.stringify({ id: 3,
            role: doctor ? 'researcher' : 'patient', patient_profile: doctor ? null : { id: 8 } }));
        window.SMARTBRAIN_API_BASE_URL = `${location.origin}/api/v1`;
        if (query) history.replaceState({}, '', query);
    }, { doctor, query: options.query });
    const calls = [], pending = new Map();
    page.removeAllListeners('request');
    page.on('request', request => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/v1/')) return request.abort();
        calls.push({ path: url.pathname + url.search, method: request.method() });
        const send = (value, status = 200) => request.respond({ status,
            contentType: 'application/json', body: JSON.stringify(value) }).catch(() => {});
        if (url.pathname.endsWith('/identity/context')) return send({ user_id: 3,
            accessible_patients: [{ patient_id: 8, display_name: '合成本人' },
                { patient_id: 9, display_name: '合成已核验监护档案' }] });
        if (url.pathname.endsWith('/attention') || url.pathname.endsWith('/work_queue')) {
            const patientId = doctor ? 8 : Number(url.searchParams.get('patient_id'));
            const items = options.items || [item(undefined, doctor ? {
                owner_kind: 'doctor', responsible_doctor_id: 3, relationship_id: 51 } : { patient_id: patientId })];
            return send({ items, service_coverage: { status: 'not_configured' } });
        }
        if (url.pathname.endsWith('/evidence')) {
            const submission = decodeURIComponent(url.pathname.split('/').at(-2));
            const result = clone(evidence(submission));
            if (doctor) result.ack.acceptance_status = 'pending_review';
            if (options.delayEvidence === submission) { pending.set(submission, () => send(result)); return; }
            return send(result);
        }
        if (url.pathname.endsWith('/daily-history')) return send({ items: options.history || cycle.records });
        if (url.pathname.endsWith('/cycles/61')) return send(cycle);
        if (url.pathname.endsWith('/cycles')) return send({ items: options.withCycle ? [cycle] : [] });
        return send({ detail: `Unexpected synthetic spec route: ${url.pathname}` }, 500);
    });
    for (const file of [`${side}/js/session-guard.js`, `${side}/js/api.js`, 'doctor-web/js/care-workbench.js']) {
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), 'utf8') });
    }
    return { page, calls, pending };
}
const loaded = page => page.waitForFunction(() => document.getElementById('careMessage').textContent.includes('已读取'));
const settled = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const visible = (page, selector) => page.$eval(selector, element => element.innerText);
const privateText = page => page.evaluate(() => ['careAttention', 'careCycles', 'careEvidence', 'careCycleDetails', 'careHistory']
    .map(id => document.getElementById(id).textContent).join(''));

test('nested saved metrics and self acceptance are readable while technical originals stay collapsed', async () => {
    const { page, calls } = await open();
    try {
        await loaded(page); await page.click('[data-evidence-id="spec-original-A"]'); await loaded(page);
        const text = await visible(page, '#careEvidence');
        for (const expected of ['无需医生验收', '自助材料已齐备', '正确率：100%', '已保存试次：24 次', '正确试次：24 次']) assert.ok(text.includes(expected), expected);
        assert.doesNotMatch(text, /医生已验收|not_required|raw_result|RAW-DETAILS-ONLY|AUTH-SNAPSHOT-ONLY|aesgcm/);
        assert.equal(await page.$eval('#careEvidence details', element => element.open), false);
        assert.ok(calls.every(call => call.method === 'GET'));
        assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('saved-spec-original')), false);
    } finally { await page.close(); }
});

test('attention quality explanations use readable labels for known server reason codes', async () => {
    const { page } = await open();
    try {
        await loaded(page);
        const text = await visible(page, '#careAttention');
        assert.match(text, /输入方式未确认/);
        assert.doesNotMatch(text, /unknown_input/);
    } finally { await page.close(); }
});

test('the newest evidence action keeps its original submission when an older response arrives late', async () => {
    const { page, calls, pending } = await open({ items: [item(), item('spec-original-B')], delayEvidence: 'spec-original-A' });
    try {
        await loaded(page); assert.equal(calls.some(call => call.path.endsWith('/evidence')), false);
        await page.click('[data-evidence-id="spec-original-A"]');
        await page.waitForFunction(() => document.getElementById('careMessage').textContent.includes('正在读取原提交'));
        await page.click('[data-evidence-id="spec-original-B"]'); await loaded(page);
        await pending.get('spec-original-A')(); await settled(page);
        const text = await visible(page, '#careEvidence');
        assert.match(text, /saved-spec-original-B/); assert.doesNotMatch(text, /saved-spec-original-A/);
    } finally { await page.close(); }
});

test('visibility hidden clears selected profile and every private panel before a pending response finishes', async () => {
    const { page, pending } = await open({ delayEvidence: 'spec-original-A', withCycle: true });
    try {
        await loaded(page); await page.click('[data-evidence-id="spec-original-A"]');
        await page.waitForFunction(() => document.getElementById('careMessage').textContent.includes('正在读取原提交'));
        await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            document.dispatchEvent(new Event('visibilitychange')); });
        await pending.get('spec-original-A')(); await settled(page);
        assert.equal(await privateText(page), '');
        assert.equal(await page.$eval('#carePatient', element => element.options.length), 0);
        assert.equal(await page.$eval('#careRefresh', element => element.disabled), true);
    } finally { await page.close(); }
});

test('a different selected accessible profile invalidates a pending original without borrowing the previous profile', async () => {
    const { page, calls, pending } = await open({ delayEvidence: 'spec-original-A' });
    try {
        await loaded(page); await page.click('[data-evidence-id="spec-original-A"]');
        await page.waitForFunction(() => document.getElementById('careMessage').textContent.includes('正在读取原提交'));
        await page.select('#carePatient', '9'); await loaded(page);
        await pending.get('spec-original-A')(); await settled(page);
        assert.equal(await page.$eval('#careEvidence', element => element.textContent), '');
        assert.match(await visible(page, '#careAttention'), /档案 #9/);
        assert.ok(calls.some(call => call.path === '/api/v1/care/patient/attention?patient_id=9'));
        assert.ok(calls.some(call => call.path === '/api/v1/care/cycles?patient_id=9'));
    } finally { await page.close(); }
});

test('daily history refuses a different real date and clears already displayed cycle originals', async () => {
    const wrongDate = { ...cycle.records[0], record_date: '2026-10-02', content: { note: 'wrong-date-private' } };
    const { page, calls } = await open({ withCycle: true, history: [wrongDate] });
    try {
        await loaded(page); await page.click('[data-cycle-id="61"]');
        await page.waitForSelector('[data-history-date="2026-10-01"]');
        const text = await visible(page, '#careCycleDetails');
        assert.match(text, /2026-10-01 至 2026-10-03/); assert.match(text, /专注时长：0 分钟/);
        assert.match(text, /33\.3%/); assert.match(text, /2026-10-02、2026-10-03/);
        await page.click('[data-history-date="2026-10-01"]');
        await page.waitForFunction(() => document.getElementById('careMessage').textContent.includes('不一致'));
        assert.equal(await privateText(page), '');
        assert.ok(calls.some(call => call.path.endsWith('/cycles/61/daily-history?record_date=2026-10-01')));
    } finally { await page.close(); }
});

test('doctor reads only the original responsible queue and preserves pending clinical acceptance', async () => {
    const { page, calls } = await open({ doctor: true });
    try {
        await loaded(page); await page.click('[data-evidence-id="spec-original-A"]'); await loaded(page);
        const text = await visible(page, '#careEvidence');
        assert.match(text, /待医生验收/); assert.doesNotMatch(text, /医生已验收/);
        assert.equal(calls.some(call => /\/cycles(?:\/|\?|$)/.test(call.path)), false);
        assert.ok(calls.some(call => call.path === '/api/v1/care/doctor/work_queue'));
        assert.ok(calls.every(call => call.method === 'GET'));
        assert.equal(await page.$eval('[data-assessment-link]', element => element.getAttribute('href')), 'doctor_assessments.html?patient_id=8');
        assert.match(await visible(page, '[data-assessment-link]'), /列表/);
    } finally { await page.close(); }
});
