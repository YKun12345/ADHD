// Actual API, two synthetic temporary databases, real mini controllers and Chrome.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const puppeteer = require('puppeteer-core');
const { createHarness } = require('../../miniprogram/tests/helpers/cognitive-harness');
const root = path.resolve(__dirname, '../..');
for (const [mode, status, label] of [['missing', 'storage_upgrade_required', /存储.*升级/], ['legacy', 'conversion_required', /旧记录.*转换/]]) {
    test(`actual ${mode} storage keeps lawful scale readable and shows its real status on both mini and web reports`, { timeout: 90000 }, async () => {
        const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
        const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
        const origin = `http://127.0.0.1:${port}`, base = origin + '/api/v1';
        const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_imaging_storage_server.py'), String(port)],
            { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', USE_MOCK_MODEL: 'mock', CARE_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '', browser, harness; const errors = [], observations = [], reports = {};
        server.stdout.on('data', value => { log += value; }); server.stderr.on('data', value => { log += value; });
        async function api(route, auth, body, expected = 200) {
            const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
                headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
                    ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w09-local-synthetic-storage-only' } : {}) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            const result = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`); return result;
        }
        try {
            for (let n = 0; n < 300; n++) {
                if (server.exitCode !== null) throw new Error(log);
                try { if ((await fetch(origin)).ok) break; } catch (_) {}
                if (n === 299) throw new Error('Synthetic startup timed out'); await pause(100);
            }
            const register = (name, role) => api('/auth/register', null, { email: `w09-${mode}-${name}@example.org`, full_name: '合成影像存储核对',
                password: 'Synthetic#2026', role, consent_agreed: role === 'patient', ...(role === 'patient' ? { patient_profile: { age: 26, patient_type: 'adult' } } : {}) }, 201);
            const owner = await register('owner', 'patient'), doctor = await register('doctor', 'researcher'), pid = owner.user.patient_profile.id;
            await api('/__synthetic__/storage-fixture', null, { mode: 'qualify', user_id: doctor.user.id });
            const invitation = await api('/care/relationships/invitations', doctor, { target_email: owner.user.email,
                purpose: 'clinical_sharing', scope: ['profile', 'assessment', 'tracking', 'imaging'] }, 201);
            const relationship = await api(`/care/relationships/${invitation.id}/accept`, owner, { expected_revision: invitation.revision });
            await api('/patient/submit_scale', owner, { scale_type: 'ASRS', answers: Array(18).fill(1) }, 201);
            await api('/__synthetic__/storage-fixture', null, { mode, patient_id: pid });
            for (const [role, auth, route] of [['patient', owner, '/patient/comprehensive_report'], ['doctor', doctor, `/doctor/patient/${pid}/report`]]) {
                const report = await api(route, auth);
                reports[role] = report;
                assert.equal(report.imaging_history_status, status); assert.ok(report.latest_scale);
                assert.equal(report.latest_model_prediction, null); assert.equal(report.latest_imaging_visualization, null);
                assert.doesNotMatch(JSON.stringify(report), /synthetic-unconverted-private/);
                observations.push({ role, actual_http_status: 200, imaging_history_status: status, scale_id: report.latest_scale.id });
            }
            for (const [role, auth, pageName] of [['patient', owner, 'report'], ['researcher', doctor, 'doctor-patient']]) {
                harness = createHarness(); harness.restore();
                Object.assign(harness.storage, { current_user: auth.user, access_token: auth.access_token, api_base_url: base });
                delete require.cache[require.resolve('../../miniprogram/utils/request')];
                wx.request = options => {
                    fetch(options.url, { method: options.method, headers: options.header,
                        ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }) })
                        .then(async response => options.success({ statusCode: response.status, data: await response.json() }))
                        .catch(error => options.fail({ errMsg: error.message }));
                };
                const page = harness.load(pageName, { query: { patient_id: String(pid) } });
                if (page._loadPromise) await page._loadPromise;
                for (let n = 0; n < 150 && !(role === 'patient' ? page.data.professional.historyStatusText : page.data.report?.professional.historyStatusText); n++) await pause(20);
                const rendered = role === 'patient' ? page.data : page.data.report;
                assert.match(rendered.professional.historyStatusText, label); assert.equal(rendered.professional.hasData, false);
                assert.ok(rendered.scale); if (role === 'patient') assert.equal(rendered.scale.hasData, true);
                page.onHide(); harness.restore(); harness = null;
            }
            browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
                userDataDir: fs.mkdtempSync(path.join(root, '.codex-tmp/w09-storage-status-browser-')), args: ['--no-first-run', '--disable-background-networking'] });
            for (const [role, auth, file] of [['patient', owner, 'patient-web/patient_report.html'], ['doctor', doctor, `doctor-web/doctor_report.html?patient_id=${pid}`]]) {
                const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
                await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 });
                await page.evaluateOnNewDocument(({ base, auth }) => { window.SMARTBRAIN_API_BASE_URL = base;
                    localStorage.setItem('smartbrain_token', auth.access_token); localStorage.setItem('smartbrain_user', JSON.stringify(auth.user)); }, { base, auth });
                await page.goto(`${origin}/${file}`, { waitUntil: 'domcontentloaded' });
                await page.waitForFunction(() => !!document.querySelector('#imagingHistoryStatus')?.textContent);
                assert.match(await page.$eval('#imagingHistoryStatus', node => node.textContent), label);
                assert.equal(await page.$eval('#reportContent', node => node.classList.contains('hidden')), false);
                assert.equal(await page.$eval('#reportScaleTitle', node => node.textContent), `${reports[role].latest_scale.scale_type} 量表结果`);
                assert.equal(await page.$eval('#reportSummary', node => node.textContent), reports[role].latest_scale.summary);
                assert.equal(await page.$eval('#imagingSection', node => node.classList.contains('hidden')), true);
                assert.equal(await page.$eval('#modelPredictionSection', node => node.classList.contains('hidden')), true);
                assert.doesNotMatch(await page.$eval('#reportContent', node => node.textContent), /synthetic-unconverted-private/);
                await page.$eval('#imagingHistoryStatus', node => node.scrollIntoView({ block: 'center' }));
                await page.screenshot({ path: path.join(root, `docs/evidence/w09-storage-${mode}-${role}.png`) });
                const layout = await page.evaluate(() => ({ viewport: window.innerWidth, scroll: document.documentElement.scrollWidth,
                    wide: Array.from(document.querySelectorAll('body *')).filter(node => node.getBoundingClientRect().right > innerWidth + 1)
                        .slice(0, 25).map(node => ({ tag: node.tagName, id: node.id, class: node.className, right: node.getBoundingClientRect().right,
                            width: node.getBoundingClientRect().width, grid: getComputedStyle(node).gridTemplateColumns })) }));
                fs.writeFileSync(path.join(root, `docs/evidence/w09-storage-${mode}-${role}-layout.json`), JSON.stringify(layout, null, 2));
                assert.equal(layout.scroll > layout.viewport, false, JSON.stringify(layout));
                await page.close();
            }
            await api(`/model/predict_mock?patient_id=${pid}`, owner, {}, 503);
            await api(`/doctor/patient/${pid}/imaging_visualization`, doctor, { visualization_type: 'nifti' }, 503);
            await api(`/care/relationships/${relationship.id}/revoke`, owner, { expected_revision: relationship.revision });
            await api(`/doctor/patient/${pid}/report`, doctor, undefined, 403);
            assert.deepEqual(errors, []);
            fs.writeFileSync(path.join(root, `docs/evidence/w09-storage-${mode}-receipt.json`), JSON.stringify({ actual_http: true,
                actual_mini_controllers: true, actual_chrome: await browser.version(), synthetic_temporary_stores: true,
                native_wechat_verified: false, observations, page_errors: errors, unauthorized_after_revocation: true }, null, 2));
        } finally {
            harness?.restore(); await browser?.close(); server.kill();
            await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)]);
            fs.writeFileSync(path.join(root, `docs/evidence/w09-storage-${mode}-http-server.txt`), log);
        }
    });
}
