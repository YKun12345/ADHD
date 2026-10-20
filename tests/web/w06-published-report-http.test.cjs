const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process'), { setTimeout: pause } = require('node:timers/promises');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '../..');
test('both real web pages read the exact actual published version and clear it on hide', { timeout: 120000 }, async () => {
    for (const file of ['doctor-web/doctor_reports.html', 'patient-web/patient_reports.html']) assert.ok(fs.existsSync(path.join(root, file)), file);
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`, base = origin + '/api/v1';
    const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)],
        { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let browser, log = ''; const errors = [], observations = [];
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
        const { owner, doctor, assessment } = await api('/__synthetic__/review-source', null, { child: false });
        const context = await api(`/care/assessments/${assessment.id}/review-context`, doctor);
        const body = '医生实际核对原始试次。<img src=x onerror="window.__xss=1">';
        const draft = await api('/care/reviews', doctor, { client_review_id: 'web-original-review', patient_id: assessment.patient_id,
            assessment_id: assessment.id, expected_assessment_version: context.assessment_version, input_digest: context.input_digest,
            review_context: context.review_context, category: 'evidence_review', body, limitations: '合成演示；当前材料有限，不能作诊断。',
            decisions: context.submissions.map(row => ({ submission_id: row.submission_id, assessment_item_id: row.assessment_item_id,
                attempt_id: row.attempt_id, decision: 'needs_repeat', reason: '实际试次中断，应新建尝试。' })), confirmed: true }, 201);
        const publish = await api(`/care/reviews/${draft.id}/publication-context`, doctor);
        const saved = await api('/care/review-publications', doctor, { client_publication_id: 'web-original-publication',
            patient_id: assessment.patient_id, assessment_id: assessment.id, review_id: draft.id,
            expected_assessment_version: publish.expected_assessment_version, expected_previous_report_version: publish.expected_previous_report_version,
            input_digest: draft.input_digest, publication_context: publish.publication_context, confirmed: true }, 201);
        browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
            userDataDir: fs.mkdtempSync(path.join(root, '.codex-tmp/w06-report-browser-')), args: ['--no-first-run', '--disable-background-networking'] });
        for (const [role, auth, file] of [['doctor', doctor, 'doctor-web/doctor_reports.html'], ['patient', owner, 'patient-web/patient_reports.html']]) {
            const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
            await page.setViewport({ width: 430, height: 900 });
            await page.evaluateOnNewDocument(({ base, auth }) => { window.SMARTBRAIN_API_BASE_URL = base; window.__xss = 0;
                localStorage.setItem('smartbrain_token', auth.access_token); localStorage.setItem('smartbrain_user', JSON.stringify(auth.user)); }, { base, auth });
            await page.goto(`${origin}/${file}?patient_id=${assessment.patient_id}&assessment_id=${assessment.id}`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector(`[data-report-id="${saved.id}"]`); await page.click(`[data-report-id="${saved.id}"]`);
            await page.waitForFunction(() => !!document.querySelector('#reportBody')?.textContent);
            assert.equal(await page.$eval('#reportBody', node => node.textContent), body);
            assert.equal(await page.$eval('#reportLimitations', node => node.textContent), saved.limitations);
            assert.match(await page.$eval('#reportDetail', node => node.textContent), /证据审核/);
            assert.equal(await page.evaluate(() => window.__xss), 0);
            assert.equal(await page.$eval('#reportDetail', node => node.querySelectorAll('img,script').length), 0);
            const layout = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
            assert.ok(layout.scroll <= layout.viewport, JSON.stringify(layout));
            await page.screenshot({ path: path.join(root, `docs/evidence/w06-published-report-${role}.png`), fullPage: true });
            await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
            assert.equal(await page.$eval('#reportDetail', node => node.textContent), '');
            observations.push({ role, report_id: saved.id, report_version: saved.version, actual_doctor_id: saved.actor_user_id,
                exact_body: true, text_only: true, clear_on_hide: true, layout }); await page.close();
        }
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(root, 'docs/evidence/w06-published-report-web-receipt.json'), JSON.stringify({ actual_tcp_http: true,
            actual_chrome: await browser.version(), synthetic_temporary_stores: true, observations, page_errors: errors }, null, 2));
    } finally { await browser?.close(); server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)]);
        fs.writeFileSync(path.join(root, 'docs/evidence/w06-published-report-web-server.txt'), log); }
});
