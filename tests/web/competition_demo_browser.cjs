// Live isolated competition service: normal login form and real Findviz upload.
// Reads synthetic credentials locally; never writes passwords, tokens or bodies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const root = path.resolve(__dirname, '../..');
const demoRoot = path.join(root, '.codex-tmp/competition-demo');
const evidence = path.join(root, 'docs/evidence/competition-demo-2026-10-18');

function currentStore() {
    if (process.argv[2]) return path.resolve(process.argv[2]);
    const pointer = path.join(demoRoot, 'current.json');
    if (fs.existsSync(pointer)) {
        const current = JSON.parse(fs.readFileSync(pointer, 'utf8'));
        if (current.runtime) return path.resolve(current.runtime);
    }
    const base = path.join(demoRoot, 'stores');
    const candidates = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .map(entry => path.join(base, entry.name))
        .filter(store => fs.existsSync(path.join(store, 'source.json')) && fs.existsSync(path.join(store, 'running.json')))
        .sort((a, b) => fs.statSync(path.join(b, 'running.json')).mtimeMs - fs.statSync(path.join(a, 'running.json')).mtimeMs);
    assert.ok(candidates.length, 'No ready marked synthetic competition store.');
    return candidates[0];
}

async function run() {
    const store = currentStore();
    assert.ok(path.relative(path.join(demoRoot, 'stores'), store) &&
        !path.relative(path.join(demoRoot, 'stores'), store).startsWith('..'), 'Store escaped the synthetic runtime.');
    const marker = JSON.parse(fs.readFileSync(path.join(store, 'competition-demo.json'), 'utf8'));
    const running = JSON.parse(fs.readFileSync(path.join(store, 'running.json'), 'utf8'));
    const source = JSON.parse(fs.readFileSync(path.join(store, 'source.json'), 'utf8'));
    assert.equal(marker.synthetic, true); assert.equal(marker.service, 'adhd-competition-demo/v1');
    assert.equal(source.synthetic_only, true); assert.equal(running.synthetic, true);
    const origin = new URL(running.url).origin;
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    assert.ok(!['8000', '8767'].includes(new URL(origin).port), 'Original service ports are forbidden.');
    const info = await (await fetch(origin + '/api/v1/__synthetic__/competition-info')).json();
    assert.equal(info.store_id, marker.store_id); assert.equal(info.synthetic, true);
    const doctor = source.accounts.doctor;
    const pid = source.scenarios.followup.patient_id;
    const functional = path.resolve(source.imaging.assets.nifti_functional.path);
    const anatomical = path.resolve(source.imaging.assets.nifti_anatomical.path);
    for (const asset of [functional, anatomical]) {
        assert.ok(!path.relative(path.join(store, 'synthetic-imaging'), asset).startsWith('..'));
        assert.ok(fs.existsSync(asset));
    }
    fs.mkdirSync(evidence, { recursive: true });
    const screenshot = path.join(evidence, '09-网页原始影像可视化.png');
    const receiptFile = path.join(evidence, '09-网页原始影像可视化.json');
    const profile = fs.mkdtempSync(path.join(store, 'browser-check-'));
    const calls = [], errors = [], failedLocalResources = [], optionalResourceNotices = [], forbiddenCalls = [];
    let browser, stage = 'launch';
    try {
        browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
            headless: true, userDataDir: profile, protocolTimeout: 60000,
            args: ['--no-first-run', '--disable-background-networking', '--disable-sync'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 1 });
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => dialog.dismiss());
        await page.setRequestInterception(true);
        page.on('request', request => {
            const url = request.url();
            if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return request.continue();
            const parsed = new URL(url);
            if (parsed.origin === origin) return request.continue();
            if (['localhost', '127.0.0.1'].includes(parsed.hostname)) forbiddenCalls.push(parsed.origin + parsed.pathname);
            return request.abort();
        });
        page.on('response', response => {
            const url = new URL(response.url());
            if (url.origin !== origin) return;
            if (url.pathname.startsWith('/api/v1/') || (url.pathname.startsWith('/findviz/') && !url.pathname.startsWith('/findviz/static/'))) {
                calls.push({ method: response.request().method(), path: url.pathname, status: response.status(), origin: url.origin });
            }
            if (response.status() >= 400) {
                const target = url.pathname === '/favicon.ico' ? optionalResourceNotices : failedLocalResources;
                target.push({ path: url.pathname, status: response.status() });
            }
        });

        stage = 'normal_doctor_login';
        await page.goto(origin + '/doctor-web/login.html', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#emailInput');
        await page.click('.segment-pill[data-role="researcher"]');
        await page.type('#emailInput', doctor.email);
        await page.type('#passwordInput', doctor.password);
        if (!(await page.$eval('#researcherConsentCheckbox', input => input.checked))) await page.click('#researcherConsentWrap .checkmark');
        await page.waitForFunction(() => !document.querySelector('#submitBtn').disabled);
        const loginResponse = page.waitForResponse(response => response.url() === origin + '/api/v1/auth/login' && response.request().method() === 'POST');
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }), page.click('#submitBtn')]);
        assert.equal((await loginResponse).status(), 200);
        const session = await page.evaluate(() => {
            const user = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
            return { user_id: user?.id, role: user?.role };
        });
        assert.equal(session.user_id, doctor.user.id); assert.equal(session.role, 'researcher');

        stage = 'patient_workspace';
        await page.goto(origin + source.imaging.pages.doctor_visualization, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => window.__doctorVizModuleBooted && document.querySelector('#timeseriesPatientHint')?.textContent.includes('已锁定'));
        const configuration = await page.evaluate(() => ({ api_base: window.SMARTBRAIN_API_BASE_URL,
            findviz_base: window.FINDVIZ_BASE_PATH, patient_id: window.FINDVIZ_PATIENT_ID,
            patient_context: document.querySelector('#timeseriesPatientHint').textContent }));
        assert.equal(configuration.api_base, origin + '/api/v1');
        assert.equal(configuration.findviz_base, origin + '/findviz');
        assert.equal(configuration.patient_id, pid);
        await (await page.$('#nifti-func')).uploadFile(functional);
        await (await page.$('#nifti-anat')).uploadFile(anatomical);

        stage = 'actual_nifti_upload_and_render';
        const uploaded = page.waitForResponse(response => response.url() === origin + '/findviz/upload' && response.request().method() === 'POST', { timeout: 60000 });
        await page.click('#submit-file');
        assert.equal((await uploaded).status(), 201);
        await page.waitForFunction(() => document.querySelector('#uploadActionFeedback')?.classList.contains('success'), { timeout: 60000 });
        await page.waitForFunction(() => [1, 2, 3].every(index => {
            const plot = document.getElementById(`slice-${index}-container`);
            return plot?.data?.some(trace => Array.isArray(trace.z) && trace.z.flat().some(value => Number.isFinite(value) && value !== 0)) && plot.querySelector('.main-svg');
        }), { timeout: 30000 });
        const render = await page.evaluate(() => ({ feedback: document.querySelector('#uploadActionFeedback').textContent,
            plotly_version: Plotly.version, slices: [1, 2, 3].map(index => {
                const plot = document.getElementById(`slice-${index}-container`);
                const trace = plot.data.find(trace => Array.isArray(trace.z));
                return { id: plot.id, rows: trace.z.length, columns: trace.z[0].length,
                    nonzero: trace.z.flat().filter(value => Number.isFinite(value) && value !== 0).length,
                    rendered_svg: !!plot.querySelector('.main-svg') };
            }) }));
        assert.deepEqual(forbiddenCalls, [], 'A browser request attempted to cross to another local service.');
        assert.deepEqual(errors, []); assert.deepEqual(failedLocalResources, []);
        for (const [method, endpoint, status] of [['POST', '/api/v1/auth/login', 200], ['POST', '/api/v1/imaging/session', 200],
            ['POST', '/findviz/upload', 201], ['GET', '/findviz/get_viewer_metadata', 200], ['GET', '/findviz/get_fmri_data', 200]]) {
            assert.ok(calls.some(call => call.method === method && call.path === endpoint && call.status === status), endpoint);
        }
        stage = 'screenshot';
        await page.$eval('#parent-container', node => window.scrollTo(0, node.getBoundingClientRect().top + window.scrollY - 150));
        await page.screenshot({ path: screenshot, fullPage: false });
        const receipt = { verified_at: new Date().toISOString(), synthetic_only: true, store_id: marker.store_id,
            origin, normal_login_form: true, isolated_browser_profile: true, page: page.url(), configuration,
            actual_findviz_upload: true, render, screenshot, external_network_requests_blocked: true,
            cross_store_requests: forbiddenCalls, errors, failed_local_resources: failedLocalResources,
            optional_resource_notices: optionalResourceNotices,
            http_receipts: Array.from(new Map(calls.map(call => [JSON.stringify(call), call])).values()),
            native_miniprogram_screenshots_claimed: 0, passwords_or_tokens_recorded: false };
        fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
        console.log(JSON.stringify({ passed: true, origin, store_id: marker.store_id, screenshot, receipt: receiptFile,
            real_slices: render.slices.length, cross_store_requests: forbiddenCalls.length }));
    } catch (error) {
        const failure = { passed: false, stage, origin, store_id: marker.store_id, error: error.message,
            errors, failed_local_resources: failedLocalResources, cross_store_requests: forbiddenCalls,
            http_receipts: calls, passwords_or_tokens_recorded: false };
        fs.writeFileSync(path.join(evidence, '09-网页原始影像可视化-failure.json'), JSON.stringify(failure, null, 2));
        throw error;
    } finally { await browser?.close(); }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
