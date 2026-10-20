// Actual API and Chrome, three independent temporary stores, synthetic ROI only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '../..');
for (const mode of ['real', 'auto', 'mock']) test(`actual ${mode} imaging page and API enforce current provenance admission`, { timeout: 90000 }, async () => {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`, base = origin + '/api/v1';
    const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_authorization_server.py'), String(port)],
        { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', USE_MOCK_MODEL: mode, CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', browser;
    const errors = [], requests = [];
    server.stdout.on('data', value => { log += value; }); server.stderr.on('data', value => { log += value; });
    async function api(route, auth, body, expected = 200) {
        const multipart = body instanceof FormData;
        const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
            headers: { ...(multipart ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
                ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w02-local-synthetic-fixture-only' } : {}) },
            ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) });
        const result = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`); return result;
    }
    try {
        for (let n = 0; n < 300; n++) {
            if (server.exitCode !== null) throw new Error(log);
            try { if ((await fetch(origin)).ok) break; } catch (_) {}
            if (n === 299) throw new Error('Synthetic server startup timed out');
            await pause(100);
        }
        const register = (who, role) => api('/auth/register', null, { email: `w09-${mode}-${who}@example.org`, full_name: '合成影像准入核对',
            password: 'Synthetic#2026', role, consent_agreed: role === 'patient', ...(role === 'patient' ? { patient_profile: { age: 26, patient_type: 'adult' } } : {}) }, 201);
        const owner = await register('owner', 'patient'), doctor = await register('doctor', 'researcher'), pid = owner.user.patient_profile.id;
        await api('/__synthetic__/authority', null, { user_id: doctor.user.id });
        const invitation = await api('/care/relationships/invitations', doctor, { target_email: owner.user.email,
            purpose: 'clinical_sharing', scope: ['profile', 'imaging'] }, 201);
        await api(`/care/relationships/${invitation.id}/accept`, owner, { expected_revision: invitation.revision });
        const status = await api('/model/admission', doctor);
        assert.equal(status.real_inference_allowed, false); assert.equal(status.registry_status, 'not_configured'); assert.equal(status.inference_mode, mode);
        assert.equal(status.weights_loaded, false); assert.equal(status.artifact.status, 'missing');
        const roi = Array.from({ length: 12 }, (_, t) => Array.from({ length: 90 }, (_, r) => Math.sin(t / 2 + r / 10).toFixed(5)).join(' ')).join('\n');
        const fixtureDir = fs.mkdtempSync(path.join(root, '.codex-tmp/w09-admission-http-'));
        const fixture = path.join(fixtureDir, 'synthetic-roi.1D'); fs.writeFileSync(fixture, roi);
        browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
            userDataDir: path.join(fixtureDir, 'chrome'), args: ['--no-first-run', '--disable-background-networking'] });
        const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
        await page.setViewport({ width: 1440, height: 1000 });
        await page.evaluateOnNewDocument(({ base, doctor, pid }) => {
            window.SMARTBRAIN_API_BASE_URL = base;
            localStorage.setItem('smartbrain_token', doctor.access_token); localStorage.setItem('smartbrain_user', JSON.stringify(doctor.user));
            localStorage.setItem('smartbrain_selected_patient_id', String(pid));
        }, { base, doctor, pid });
        await page.setRequestInterception(true);
        page.on('request', request => request.url().startsWith(origin) || request.url().startsWith('data:') ? request.continue() : request.abort());
        page.on('response', response => { if (response.url().startsWith(base)) requests.push({ path: new URL(response.url()).pathname, method: response.request().method(), status: response.status() }); });
        await page.goto(`${origin}/doctor-web/doctor_imaging.html?patient_id=${pid}`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(mode => document.getElementById('modelAdmissionStatus').textContent.includes(mode === 'mock' ? '演示' : '准入核验'), {}, mode);
        await page.waitForFunction(() => document.getElementById('timeseriesPatientHint').textContent.includes('已锁定'));
        await (await page.$('#timeseriesFileInput')).uploadFile(fixture);
        if (mode === 'mock') {
            assert.equal(await page.$eval('#generateReportBtn', node => node.disabled), false);
            await page.click('#generateReportBtn');
            await page.waitForFunction(() => document.getElementById('predictionStatusBadge').textContent === '演示完成');
            assert.match(await page.$eval('#predictionSummary', node => node.textContent), /演示.*不用于临床/);
            assert.equal(await page.$eval('#connectivityStatusBadge', node => node.textContent), '演示未计算');
            const report = await api(`/doctor/patient/${pid}/report`, doctor);
            assert.equal(report.latest_model_prediction.is_demo, true); assert.equal(report.latest_model_prediction.source_type, 'mock');
            const savedVisualization = await api(`/doctor/patient/${pid}/imaging_visualization`, doctor, { visualization_type: 'nifti',
                slice_interpretation: '实际接口保存的合成切片说明。', notes: '合成影像补充说明，专业审核未记录。' }, 201);
            const { createHarness } = require('../../miniprogram/tests/helpers/cognitive-harness');
            const previous = { wx: global.wx, Page: global.Page, getCurrentPages: global.getCurrentPages }, h = createHarness(), pending = new Set();
            // Read-only controllers use real networking, not the cognitive fake
            // clock. Undici and Chrome need native Timeout objects with unref().
            h.restore();
            try {
                Object.assign(h.storage, { api_base_url: base, access_token: doctor.access_token, current_user: doctor.user });
                delete require.cache[require.resolve('../../miniprogram/utils/request')];
                wx.request = options => {
                    const operation = fetch(options.url, { method: options.method, headers: options.header })
                        .then(async response => {
                            requests.push({ path: new URL(options.url).pathname, method: options.method, status: response.status, transport: 'actual_mini' });
                            options.success({ statusCode: response.status, data: await response.json() });
                        }).catch(error => options.fail({ errMsg: error.message }));
                    pending.add(operation); operation.then(() => pending.delete(operation));
                };
                const drain = async () => { while (pending.size) await Promise.allSettled([...pending]); await h.flush(); };
                let mini = h.load('doctor-patient', { query: { patient_id: String(pid) } }); await mini._loadPromise; await drain();
                assert.equal(mini.data.report.professional.imagingSummary, savedVisualization.summary_text);
                assert.match(mini.data.report.professional.doctorInterpretation, /合成切片说明/);
                assert.match(mini.data.report.professional.doctorNotes, /合成影像补充说明/);
                assert.equal(mini.data.report.professional.confidenceLabel, '未提供校准置信度');
                assert.match(mini.data.report.professional.sourceStatusText, /演示.*不用于临床/);
                assert.match(mini.data.report.professional.reviewStatusText, /审核.*未记录/);
                mini.onHide(); assert.equal(mini.data.report, null);
                const privacy = require('../../miniprogram/utils/session-privacy');
                privacy.replacePatientSession({ access_token: owner.access_token, user: owner.user });
                mini = h.load('report'); await drain();
                assert.equal(mini.data.professional.imagingSummary, savedVisualization.summary_text);
                assert.match(mini.data.professional.doctorInterpretation, /合成切片说明/);
                assert.match(mini.data.professional.modelSummary, /演示/);
                assert.equal(mini.data.professional.confidenceLabel, '未提供校准置信度');
                mini.onHide(); assert.equal(mini.data.professional.hasData, false);
                await api(`/care/relationships/${invitation.id}/revoke`, owner, { expected_revision: 2 });
                privacy.replacePatientSession({ access_token: doctor.access_token, user: doctor.user });
                mini = h.load('doctor-patient', { query: { patient_id: String(pid) } }); await mini._loadPromise; await drain();
                assert.equal(mini.data.report, null); assert.match(mini.data.errorText, /authority|授权/);
                mini.onUnload();
            } finally { while (pending.size) await Promise.allSettled([...pending]); h.restore(); Object.assign(global, previous); }
        } else {
            assert.equal(await page.$eval('#generateReportBtn', node => node.disabled), true);
            assert.match(await page.$eval('#generateReportBtn', node => node.textContent), /待准入/);
            await page.evaluate(() => document.getElementById('generateReportBtn').dispatchEvent(new Event('click')));
            assert.equal(requests.some(row => row.method === 'POST' && row.path.includes('predict_fmri')), false);
            const form = new FormData(); form.append('timeseries_file', new Blob([roi]), 'synthetic-roi.1D');
            const denied = await api(`/model/predict_fmri?patient_id=${pid}`, doctor, form, 503);
            assert.match(denied.detail, /准入/);
            assert.equal((await api(`/doctor/patient/${pid}/report`, doctor)).latest_model_prediction, null);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(root, `docs/evidence/w09-model-admission-${mode}.png`), fullPage: true });
        fs.writeFileSync(path.join(root, `docs/evidence/w09-model-admission-${mode}-receipt.json`), JSON.stringify({
            actual_http: true, synthetic_stores_and_roi: true, mode, real_model_loaded: false, actual_source_state: status,
            requests, page_errors: errors, browser: await browser.version(), clinical_effectiveness_verified: false }, null, 2));
    } catch (error) {
        fs.writeFileSync(path.join(root, `docs/evidence/w09-model-admission-${mode}-failed.json`), JSON.stringify({ error: String(error), page_errors: errors, requests, server_log: log }, null, 2));
        throw error;
    } finally {
        if (browser) await browser.close();
        server.kill();
        if (server.exitCode === null) await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(5000)]);
    }
});
