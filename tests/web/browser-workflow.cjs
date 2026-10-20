const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '../..');
const evidence = path.join(root, 'docs/evidence');
const payload = '<img src=x onerror="window.__w01Executed=1">';
const password = 'W01Synthetic!2026';

async function availablePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function run() {
    const port = await availablePort(); const origin = `http://127.0.0.1:${port}`;
    const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(__dirname, 'isolated_server.py'), String(port)],
        { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = ''; server.stdout.on('data', b => { serverLog += b; }); server.stderr.on('data', b => { serverLog += b; });
    let browser;
    const results = [];
    const pageErrors = [];
    try {
        for (let i = 0; i < 200; i++) {
            if (server.exitCode !== null) throw new Error(`Isolated API server failed: ${serverLog}`);
            try { const res = await fetch(origin); if (res.ok) break; } catch (_) { /* Server starting. */ }
            await new Promise(resolve => setTimeout(resolve, 100));
            if (i === 199) throw new Error('Isolated API server startup timeout');
        }
        const api = async (route, body, auth, method = 'POST') => {
            const response = await fetch(`${origin}/api/v1${route}`, { method,
                headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            const json = await response.json(); assert.ok(response.ok, `${route}: ${response.status}: ${JSON.stringify(json)}`);
            return json;
        };
        const register = (name, role = 'patient') => api('/auth/register', { email: `${name}@example.org`,
            password, full_name: name === 'w01-a' ? payload : name, role, consent_agreed: true,
            ...(role === 'patient' ? { patient_profile: { patient_type: 'adult', age: 28 } } : {}) });
        const a = await register('w01-a'); const b = await register('w01-b');
        const doctor = await register('w01-doctor', 'researcher');
        await api('/doctor/bind_patient', { patient_email: 'w01-a@example.org' }, doctor);
        await api('/doctor/bind_patient', { patient_email: 'w01-b@example.org' }, doctor);
        await api('/patient/submit_daily_log', { day_index: 1, mood_tag: '3', focus_minutes: 20,
            activities: ['读书'], note: payload }, a);
        await api(`/care/doctor/patient/${a.user.patient_profile.id}/messages`, { content: payload, client_message_id: 'w01-message-synthetic-1' }, doctor);
        await api('/patient/submit_scale', { scale_type: 'ASRS', respondent_type: 'self', answers: Array(18).fill(1) }, a);
        browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, protocolTimeout: 30000,
            userDataDir: path.join(root, '.codex-tmp', `w01-chrome-${port}`), args: ['--no-first-run', '--disable-background-networking', '--disable-sync'] });
        const context = await browser.createBrowserContext();
        const open = async (route) => {
            const page = await context.newPage();
            page.on('pageerror', error => pageErrors.push(String(error)));
            await page.setViewport({ width: 1365, height: 1000 });
            await page.evaluateOnNewDocument(base => { window.SMARTBRAIN_API_BASE_URL = `${base}/api/v1`; window.__w01Executed = 0; }, origin);
            await page.setRequestInterception(true);
            page.on('request', request => {
                const url = request.url();
                if (url.startsWith(origin) || url.startsWith('data:') || url === 'about:blank') request.continue();
                else request.abort();
            });
            page.on('dialog', dialog => dialog.dismiss());
            await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
            return page;
        };
        const login = async (page, auth) => {
            // Chrome throttles RAF/layout work in background tabs; activate the
            // intended login tab before interacting with its real controls.
            await page.bringToFront();
            await page.goto(`${origin}/patient-web/login.html`, { waitUntil: 'domcontentloaded' });
            if (auth.user.role === 'researcher') await page.click('.segment-pill[data-role="researcher"]');
            await page.type('#emailInput', auth.user.email);
            await page.type('#passwordInput', password);
            const checkbox = auth.user.role === 'patient' ? '#patientConsentWrap .checkmark' : '#researcherConsentWrap .checkmark';
            const input = auth.user.role === 'patient' ? '#patientConsentCheckbox' : '#researcherConsentCheckbox';
            if (!(await page.$eval(input, e => e.checked))) await page.click(checkbox);
            await page.waitForFunction(() => !document.querySelector('#submitBtn').disabled);
            await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#submitBtn')]);
            const current = await page.evaluate(() => { const s = SessionGuard.captureSession(); return { accountId: s.accountId, role: s.role, revision: s.revision }; });
            assert.equal(current.accountId, auth.user.id); assert.ok(current.revision); return current;
        };
        const page = await open('/patient-web/login.html');
        await login(page, doctor);
        await page.goto(`${origin}/doctor-web/doctor_patients.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(text => document.querySelector('#myPatientList')?.textContent.includes(text), {}, payload);
        assert.equal(await page.$eval('#myPatientList', e => e.querySelectorAll('img[onerror],svg[onload]').length), 0);
        assert.equal(await page.evaluate(() => window.__w01Executed), 0);
        await page.screenshot({ path: path.join(evidence, 'w01-browser-doctor-patients.png'), fullPage: false });
        results.push({ scenario: 'real API synthetic patient name -> doctor list text', passed: true });

        await login(page, a);
        await page.goto(`${origin}/patient-web/patient_tracking.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(text => document.querySelector('#logsFeedList')?.textContent.includes(text), {}, payload);
        assert.equal(await page.$eval('#logsFeedList', e => e.querySelectorAll('img[onerror],svg[onload]').length), 0);
        assert.equal(await page.evaluate(() => window.__w01Executed), 0);
        await page.screenshot({ path: path.join(evidence, 'w01-browser-patient-tracking.png'), fullPage: false });
        results.push({ scenario: 'real API synthetic note/activity -> tracking text', passed: true });
        await page.goto(`${origin}/patient-web/patient_report.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(text => document.querySelector('#patientMessageList')?.textContent.includes(text), {}, payload);
        assert.equal(await page.$eval('#patientMessageList', e => e.querySelectorAll('img[onerror],svg[onload]').length), 0);
        assert.equal(await page.evaluate(() => window.__w01Executed), 0);
        results.push({ scenario: 'real doctor message -> patient report text', passed: true });

        await page.goto(`${origin}/patient-web/patient_scale.html`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => startScale('adult'));
        await page.waitForSelector('#optionsGrid .btn-option');
        await page.click('#optionsGrid .btn-option');
        await page.waitForFunction(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('smartbrain_owned_v1:'))))?.value?.length === 1);
        const loginTab = await open('/patient-web/login.html');
        await login(loginTab, b);
        await page.waitForSelector('[data-session-invalid="true"]');
        const blocked = await page.evaluate(async () => {
            try { await API.Patient.submitScale({ scale_type: 'ASRS', respondent_type: 'self', answers: Array(18).fill(4) }); return false; }
            catch (error) { return error.code === 'SESSION_CHANGED'; }
        });
        assert.equal(blocked, true);
        const bReport = await api('/patient/comprehensive_report', undefined, b, 'GET');
        assert.equal(bReport.latest_scale, null);
        results.push({ scenario: 'A unsent scale -> B login -> A submit blocked; B backend has no scale', passed: true });
        await page.screenshot({ path: path.join(evidence, 'w01-browser-session-invalid.png'), fullPage: false });

        await loginTab.goto(`${origin}/patient-web/patient_scale.html`, { waitUntil: 'domcontentloaded' });
        await loginTab.evaluate(() => {
            localStorage.setItem('tempScaleAnswers_adult', '[4,4,4]');
            localStorage.setItem('smartbrain_latest_cognitive_test', '{"accuracy":99}');
        });
        await loginTab.reload({ waitUntil: 'domcontentloaded' });
        assert.equal(await loginTab.evaluate(() => localStorage.getItem('tempScaleAnswers_adult')), null);
        await loginTab.evaluate(() => startScale('adult'));
        await loginTab.waitForFunction(() => document.querySelector('#progressText')?.textContent.includes('1 / 18'));
        assert.equal(await loginTab.evaluate(() => localStorage.getItem('smartbrain_latest_cognitive_test')), null);
        results.push({ scenario: 'anonymous old answers never resumed for B on actual scale page', passed: true });

        // Real endpoints generate both the successful A report and expired-token
        // response; only delivery is delayed by the isolated test server.
        for (const status of [200, 401]) {
            await login(loginTab, a);
            const old = await open('/patient-web/patient_report.html');
            await old.waitForFunction(() => !!API && !!SessionGuard);
            await old.evaluate(status => {
                window.__w01Ticks = 0;
                setInterval(() => window.__w01Ticks++, 10);
                window.__w01Pending = request('/patient/comprehensive_report?w01_delay_ms=4500',
                    status === 401 ? { headers: { Authorization: 'Bearer w01-deliberately-invalid' } } : {})
                    .then(value => ({ delivered: true, value }), error => ({ delivered: false, code: error.code }));
            }, status);
            await login(loginTab, b);
            await old.waitForSelector('[data-session-invalid="true"]');
            const frozenTicks = await old.evaluate(() => window.__w01Ticks);
            const outcome = await old.evaluate(() => window.__w01Pending);
            assert.equal(outcome.delivered, false); assert.equal(outcome.code, 'SESSION_CHANGED');
            await new Promise(resolve => setTimeout(resolve, 4600));
            assert.equal(await old.evaluate(() => window.__w01Ticks), frozenTicks);
            assert.equal(await loginTab.evaluate(() => JSON.parse(localStorage.getItem('smartbrain_user')).id), b.user.id);
            assert.equal(await old.evaluate(text => document.body.textContent.includes(text), payload), false);
            results.push({ scenario: `actual delayed ${status} + cross-tab B login -> old request cancelled, timer stopped, sensitive DOM cleared, B retained`, passed: true });
            await old.close();
        }

        const beforeRelogin = await login(loginTab, b);
        const oldB = await open('/patient-web/patient_report.html');
        await loginTab.goto(`${origin}/patient-web/patient_profile.html`, { waitUntil: 'domcontentloaded' });
        await loginTab.bringToFront();
        await Promise.all([loginTab.waitForNavigation({ waitUntil: 'domcontentloaded' }), loginTab.click('#accountLogout')]);
        const afterRelogin = await login(loginTab, b);
        assert.notEqual(beforeRelogin.revision, afterRelogin.revision);
        await oldB.waitForSelector('[data-session-invalid="true"]');
        results.push({ scenario: 'actual logout button + same-account login creates new revision and invalidates old B page', passed: true });

        await loginTab.evaluate(() => sessionStorage.setItem('achievement_trigger', JSON.stringify({ summary: 'A private legacy result', accuracy: 1 })));
        await login(loginTab, a);
        await login(loginTab, b);
        await loginTab.goto(`${origin}/patient-web/patient_test.html`, { waitUntil: 'domcontentloaded' });
        await new Promise(resolve => setTimeout(resolve, 800));
        assert.equal(await loginTab.evaluate(() => sessionStorage.getItem('achievement_trigger')), null);
        assert.equal(await loginTab.evaluate(() => !!document.querySelector('#achCompletionModal')), false);
        assert.equal(await loginTab.evaluate(() => Achievement.getStats().totalSessions || 0), 0);
        results.push({ scenario: 'same-tab anonymous legacy achievement notice is not exposed or credited to B', passed: true });

        await loginTab.evaluate(text => OwnedCache.write(OwnedCache.achievementContext, { test_type: 'reaction', summary: text }), payload);
        await loginTab.reload({ waitUntil: 'domcontentloaded' });
        await loginTab.waitForSelector('#achCompletionModal');
        assert.equal(await loginTab.$eval('[data-achievement-summary]', e => e.textContent), payload);
        assert.equal(await loginTab.$eval('#achCompletionModal', e => e.querySelectorAll('img[onerror]').length), 0);
        assert.equal(await loginTab.evaluate(() => window.__w01Executed), 0);
        assert.equal(await loginTab.evaluate(() => Achievement.getStats().totalSessions), 1);
        results.push({ scenario: 'matching owned local preview notice is consumed once and summary stays text', passed: true });

        const patientPage = await open('/patient-web/patient_report.html');
        await login(loginTab, doctor);
        await patientPage.waitForSelector('[data-session-invalid="true"]');
        assert.equal(await patientPage.evaluate(async () => { try { await API.Patient.getComprehensiveReport(); return false; } catch (e) { return e.code === 'SESSION_CHANGED'; } }), true);
        results.push({ scenario: 'actual patient -> doctor login invalidates old role and blocks old patient API', passed: true });

        const doctorA = await open(`/doctor-web/doctor_report.html?patient_id=${a.user.patient_profile.id}`);
        assert.equal(await doctorA.evaluate(() => SessionGuard.captureSession().patientId), a.user.patient_profile.id);
        await loginTab.goto(`${origin}/doctor-web/doctor_report.html?patient_id=${b.user.patient_profile.id}`, { waitUntil: 'domcontentloaded' });
        await doctorA.waitForSelector('[data-session-invalid="true"]');
        assert.equal(await loginTab.evaluate(() => SessionGuard.captureSession().patientId), b.user.patient_profile.id);
        results.push({ scenario: 'same doctor opening another dossier invalidates former dossier page', passed: true });
        fs.writeFileSync(path.join(evidence, 'w01-browser-workflow.json'), JSON.stringify({ date: '2026-10-13',
            scope: 'Real Chrome + actual pages/API, isolated temporary SQLite, synthetic identities/data, external scripts/AI disabled',
            browser: await browser.version(), results, passed: results.length }, null, 2));
        console.log(JSON.stringify({ passed: results.length, evidence: 'docs/evidence/w01-browser-workflow.json' }));
    } catch (error) {
        const diagnostics = [];
        if (browser) for (const p of await browser.pages()) {
            if (!p.url().startsWith(origin)) continue;
            diagnostics.push(await p.evaluate(() => ({ url: location.href, guard: !!window.SessionGuard, api: !!window.API,
                activeRole: document.querySelector('.segment-pill.active')?.dataset.role,
                email: document.querySelector('#emailInput')?.value,
                passwordLength: document.querySelector('#passwordInput')?.value.length,
                patientConsent: document.querySelector('#patientConsentCheckbox')?.checked,
                researcherConsent: document.querySelector('#researcherConsentCheckbox')?.checked,
                submitDisabled: document.querySelector('#submitBtn')?.disabled,
                feedback: document.querySelector('#formFeedback')?.textContent,
                logsFeed: document.querySelector('#logsFeedList')?.textContent,
                emptyLogs: document.querySelector('#emptyLogsText')?.textContent,
                session: window.SessionGuard?.captureSession().accountId,
                body: document.body.textContent.slice(0, 700) })));
            await p.screenshot({ path: path.join(evidence, 'w01-browser-debug.png') });
        }
        fs.writeFileSync(path.join(evidence, 'w01-browser-workflow-failed.json'), JSON.stringify({ results, pageErrors, diagnostics, error: String(error) }, null, 2));
        throw error;
    } finally {
        if (browser) await browser.close();
        server.kill();
        fs.writeFileSync(path.join(evidence, 'w01-browser-server.txt'), serverLog);
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
