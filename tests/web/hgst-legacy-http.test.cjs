// Real Chrome -> API -> retained Python3.10 HGST -> encrypted synthetic DB -> report.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '../..');
test('original HGST weight analyzes a new synthetic upload through the actual imaging page', { timeout: 100000 }, async () => {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`, base = origin + '/api/v1';
    const server = spawn(path.join(root, '.venv/Scripts/python.exe'), ['-B', path.join(root, 'tests/web/isolated_hgst_legacy_server.py'), String(port)],
        { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', browser;
    server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
    const errors = [], calls = [];
    async function api(route, auth, body, expected = 200) {
        const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
                ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w02-local-synthetic-fixture-only' } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const result = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`); return result;
    }
    try {
        for (let i = 0; i < 300; i++) {
            if (server.exitCode !== null) throw new Error(log);
            try { if ((await fetch(origin)).ok) break; } catch (_) {}
            if (i === 299) throw new Error('Synthetic API startup timed out');
            await pause(100);
        }
        const register = (name, role) => api('/auth/register', null, { email: `hgst-legacy-${name}@example.org`,
            full_name: '合成影像兼容验证', password: 'Synthetic#2026', role, consent_agreed: role === 'patient',
            ...(role === 'patient' ? { patient_profile: { age: 26, patient_type: 'adult' } } : {}) }, 201);
        const owner = await register('owner', 'patient'), doctor = await register('doctor', 'researcher');
        const pid = owner.user.patient_profile.id;
        await api('/__synthetic__/authority', null, { user_id: doctor.user.id });
        const invitation = await api('/care/relationships/invitations', doctor, { target_email: owner.user.email,
            purpose: 'clinical_sharing', scope: ['profile', 'imaging'] }, 201);
        await api(`/care/relationships/${invitation.id}/accept`, owner, { expected_revision: invitation.revision });
        const fixture = fs.mkdtempSync(path.join(root, '.codex-tmp/hgst-legacy-page-'));
        const roiPath = path.join(fixture, 'synthetic-roi.csv');
        fs.writeFileSync(roiPath, Array.from({ length: 32 }, (_, t) => Array.from({ length: 90 }, (_, r) =>
            (Math.sin(t * .37 + r * .23) + Math.cos(t * .17 * (r + 1))).toFixed(6)).join(',')).join('\n'));
        browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
            userDataDir: path.join(fixture, 'chrome'), args: ['--no-first-run', '--disable-background-networking'] });
        const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1100 });
        page.on('pageerror', error => errors.push(error.message));
        await page.evaluateOnNewDocument(({ base, doctor, pid }) => {
            window.SMARTBRAIN_API_BASE_URL = base;
            localStorage.setItem('smartbrain_token', doctor.access_token); localStorage.setItem('smartbrain_user', JSON.stringify(doctor.user));
            localStorage.setItem('smartbrain_selected_patient_id', String(pid));
        }, { base, doctor, pid });
        await page.setRequestInterception(true);
        page.on('request', request => request.url().startsWith(origin) || request.url().startsWith('data:') ? request.continue() : request.abort());
        page.on('response', response => { if (response.url().startsWith(base)) calls.push({ path: new URL(response.url()).pathname,
            method: response.request().method(), status: response.status() }); });
        await page.goto(`${origin}/doctor-web/doctor_imaging.html?patient_id=${pid}`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => !document.getElementById('generateReportBtn').disabled);
        assert.match(await page.$eval('#modelAdmissionStatus', node => node.textContent), /沿用.*权重/);
        await (await page.$('#timeseriesFileInput')).uploadFile(roiPath);
        const inferenceResponse = page.waitForResponse(response => response.url().includes('/model/predict_fmri')
            && response.request().method() === 'POST', { timeout: 60000 });
        await page.click('#generateReportBtn');
        const actualResponse = await inferenceResponse;
        assert.equal(actualResponse.status(), 200, await actualResponse.text());
        await page.waitForFunction(() => document.getElementById('predictionStatusBadge').textContent === '已完成');
        const report = await api(`/doctor/patient/${pid}/report`, doctor);
        const saved = report.latest_model_prediction;
        assert.equal(saved.is_demo, false); assert.equal(saved.source_admission_status, 'legacy_accepted');
        assert.equal(saved.roi_dim_used, 90); assert.equal(saved.timepoints, 32);
        assert.match(saved.summary_text, /旧权重.*未重新核验/);
        assert.ok(calls.some(call => call.path === '/api/v1/model/predict_fmri' && call.method === 'POST' && call.status === 200));
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(root, 'docs/evidence/hgst-legacy-page-20261018.png'), fullPage: true });
        fs.writeFileSync(path.join(root, 'docs/evidence/hgst-legacy-page-receipt-20261018.json'), JSON.stringify({
            synthetic_only: true, model_sha256: saved.storage_context.input.model_artifact_sha256,
            actual_old_weight_inference: true, training_performed: false, probability: saved.probability,
            source_admission_status: saved.source_admission_status, calls, errors }, null, 2));
    } finally { await browser?.close(); server.kill(); }
});
