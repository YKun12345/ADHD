const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process'), { setTimeout: pause } = require('node:timers/promises');
const puppeteer = require('puppeteer-core');
const { createHarness } = require('../../miniprogram/tests/helpers/cognitive-harness');
const root = path.resolve(__dirname, '../..');
test('real self-screening version is readable in mini and both web roles without a fictional doctor, and clinical withdrawal stops sharing', { timeout: 140000 }, async () => {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`, base = origin + '/api/v1';
    const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)],
        { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let browser, log = '', h, mini; const errors = [], observations = [];
    server.stdout.on('data', value => { log += value; }); server.stderr.on('data', value => { log += value; });
    async function api(route, auth, body, expected = 200) {
        const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json',
            ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}), ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w06-local-synthetic-only' } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
    }
    try {
        for (let n = 0; n < 300; n++) { if (server.exitCode !== null) throw new Error(log);
            try { if ((await fetch(origin)).ok) break; } catch (_) {}
            if (n === 299) throw new Error('Synthetic startup timeout'); await pause(100); }
        const { owner, doctor, assessment } = await api('/__synthetic__/review-source', null, { self_screening: true });
        const [report] = (await api(`/care/assessments/${assessment.id}/reports`, owner)).items;
        assert.ok(report); assert.equal(report.publisher_kind, 'system'); assert.equal(report.review_id, null);
        h = createHarness(); h.restore(); Object.assign(h.storage, { current_user: owner.user, access_token: owner.access_token, api_base_url: base });
        delete require.cache[require.resolve('../../miniprogram/utils/request')];
        wx.request = options => fetch(options.url, { method: options.method, headers: options.header,
            ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }) }).then(async response =>
            options.success({ statusCode: response.status, data: await response.json() })).catch(error => options.fail({ errMsg: error.message }));
        mini = h.load('care-reports', { query: { patient_id: String(assessment.patient_id), assessment_id: String(assessment.id) } }); await mini._loadPromise;
        assert.equal(mini.data.reports[0].categoryLabel, '自助筛查', mini.data.errorText);
        assert.equal(await mini.openReport({ currentTarget: { dataset: { id: report.id } } }), true, mini.data.errorText);
        assert.equal(mini.data.report.body, report.body); assert.equal(mini.data.report.responsible_doctor_id, null);
        mini.onHide(); assert.equal(mini.data.report, null); assert.equal(mini.data.inputText, '');
        browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
            userDataDir: fs.mkdtempSync(path.join(root, '.codex-tmp/w06-self-report-')), args: ['--no-first-run', '--disable-background-networking'] });
        for (const [role, auth, file] of [['doctor', doctor, 'doctor-web/doctor_reports.html'], ['patient', owner, 'patient-web/patient_reports.html']]) {
            const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.setViewport({ width: 430, height: 900 });
            await page.evaluateOnNewDocument(({ base, auth }) => { window.SMARTBRAIN_API_BASE_URL = base;
                localStorage.setItem('smartbrain_token', auth.access_token); localStorage.setItem('smartbrain_user', JSON.stringify(auth.user)); }, { base, auth });
            await page.goto(`${origin}/${file}?patient_id=${assessment.patient_id}&assessment_id=${assessment.id}`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector(`[data-report-id="${report.id}"]`); await page.click(`[data-report-id="${report.id}"]`);
            await page.waitForFunction(() => !!document.querySelector('#reportBody')?.textContent);
            assert.equal(await page.$eval('#reportBody', node => node.textContent), report.body);
            const text = await page.$eval('#reportDetail', node => node.textContent);
            assert.match(text, /系统筛查，未经医生专业确认/); assert.doesNotMatch(text, /实际发布医生账号/);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({ path: path.join(root, `docs/evidence/w06-self-report-${role}.png`), fullPage: true });
            await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); assert.equal(await page.$eval('#reportDetail', node => node.textContent), '');
            observations.push({ role, report_id: report.id, version: report.version, exact_body: true, system_publisher: true, clear_on_hide: true }); await page.close();
        }
        const relation = (await api('/care/relationships', owner)).items.find(row => row.doctor_user_id === doctor.user.id);
        await api(`/care/relationships/${relation.id}/revoke`, owner, { expected_revision: relation.revision });
        await api(`/care/reports/${report.id}`, doctor, undefined, 403);
        assert.equal((await api(`/care/reports/${report.id}`, owner)).body, report.body); assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(root, 'docs/evidence/w06-self-report-actual-http-receipt.json'), JSON.stringify({ actual_tcp_http: true,
            actual_mini_controller_and_request: true, actual_chrome: await browser.version(), native_wechat_verified: false,
            synthetic_temporary_stores: true, observations, clinical_withdrawal_denies_doctor_keeps_owner_history: true, page_errors: errors }, null, 2));
    } finally { mini?.onUnload(); h?.restore(); await browser?.close(); server.kill();
        await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)]);
        fs.writeFileSync(path.join(root, 'docs/evidence/w06-self-report-actual-http-server.txt'), log); }
});
