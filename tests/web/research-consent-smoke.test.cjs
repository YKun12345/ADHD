const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process'), { setTimeout: pause } = require('node:timers/promises'), puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '../..');
test('actual patient web grants and withdraws only the selected project; a lost committed ACK recovers by GET only', { timeout: 120000 }, async () => {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`, base = origin + '/api/v1';
    const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)], {
        cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', CARE_WORKER_ENABLED: 'false', DEEPSEEK_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let browser, page, stage = 'startup', log = '';
    server.stdout.on('data', value => log += value); server.stderr.on('data', value => log += value);
    async function api(route, auth, body) {
        const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json',
            ...(auth ? { Authorization: 'Bearer ' + auth.access_token } : {}), ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w06-local-synthetic-only' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
    }
    try {
        for (let i = 0; i < 300; i++) { try { if ((await fetch(origin)).ok) break; } catch {} if (i === 299) throw Error('startup timeout'); await pause(100); }
        stage = 'synthetic-source';
        const reviewer = (await api('/__synthetic__/registry-source', null, {})).reviewer;
        const { owner, assessment } = await api('/__synthetic__/review-source', null, { minimal: true }), pid = assessment.patient_id;
        const listing = await api('/federated/projects', reviewer);
        const project = await api('/federated/projects', reviewer, { client_request_id: 'patient-web-project', institution_id: listing.reviewer_institutions[0],
            name: '合成患者网页项目', purpose: '只验证具体项目授权与撤回流程', mode: 'synthetic', data_contract: 'synthetic-roi-v1', expires_at: new Date(Date.now() + 86400000 * 30).toISOString() });
        await api(`/federated/projects/${project.id}/approve`, reviewer, { client_request_id: 'patient-web-approve', expected_revision: project.revision, confirmed: true, reason: '仅临时合成网页验证' });
        browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
            userDataDir: fs.mkdtempSync(path.join(root, '.codex-tmp/patient-consent-')), args: ['--no-first-run', '--disable-background-networking'] });
        page = await browser.newPage(); const errors = [], posts = [];
        page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
        page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/federated/')) posts.push(request.url()); });
        await page.evaluateOnNewDocument(({ base, auth }) => {
            window.SMARTBRAIN_API_BASE_URL = base; localStorage.setItem('smartbrain_token', auth.access_token); localStorage.setItem('smartbrain_user', JSON.stringify(auth.user));
        }, { base, auth: owner });
        stage = 'initial'; await page.goto(`${origin}/patient-web/patient_research_consent.html?patient_id=${pid}&project_id=${project.id}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#clinicalHistory fieldset', { timeout: 30000 });
        assert.equal(await page.$$eval('#clinicalHistory input[type=checkbox]:checked', values => values.length), 0);
        assert.equal(await page.$eval('#clinicalHistory fieldset button', button => button.disabled), true);
        const readProjectRevision = (await api(`/federated/projects/${project.id}/consent?patient_id=${pid}`, owner)).project.revision;
        stage = 'grant-lost-ack';
        await page.evaluate(() => {
            const original = window.fetch;
            window.fetch = async (...args) => { const response = await original(...args); if (!window.lostResearchAck && /\/consent$/.test(String(args[0])) && args[1]?.method === 'POST') {
                window.lostResearchAck = true; await response.clone().text(); throw Error('synthetic lost ACK after commit'); } return response; };
            const assessment = document.querySelector('#clinicalHistory input[value=assessment]'); assessment.click();
            const checks = [...document.querySelectorAll('#clinicalHistory input[type=checkbox]')]; checks.at(-1).click(); document.querySelector('#clinicalHistory fieldset button').click();
        });
        await page.waitForFunction(() => document.querySelector('#clinicalPending')?.textContent.includes('按原编号查询接收结果') && !document.querySelector('#clinicalShell').hasAttribute('aria-busy'), { timeout: 30000 });
        assert.equal(posts.length, 1);
        const storedGrant = await page.evaluate(async () => {
            const response = await fetch(window.SMARTBRAIN_API_BASE_URL + '/federated/submissions/' + (await new Promise((resolve, reject) => {
                const read = indexedDB.open('smartbrain_clinical_originals_v1', 1); read.onerror = () => reject(read.error); read.onsuccess = () => {
                    const transaction = read.result.transaction('originals', 'readonly'), rows = transaction.objectStore('originals').getAll();
                    rows.onsuccess = () => resolve(rows.result[0].key.split(':').at(-1)); rows.onerror = () => reject(rows.error);
                };
            })), { headers: { Authorization: 'Bearer ' + localStorage.getItem('smartbrain_token') } });
            return response.json();
        });
        assert.equal(storedGrant.original_request.expected_project_revision, readProjectRevision);
        assert.equal(storedGrant.result.project_revision, readProjectRevision); stage = 'recover-get-only';
        await page.evaluate(() => document.querySelector('#clinicalPending button').click());
        await page.waitForFunction(() => !document.querySelector('#clinicalPending')?.textContent.trim() && document.querySelector('#clinicalHistory article')?.textContent.includes('当前有效') && !document.querySelector('#clinicalShell').hasAttribute('aria-busy'), { timeout: 30000 });
        assert.equal(posts.length, 1);
        const active = await api(`/federated/projects/${project.id}/consent?patient_id=${pid}`, owner);
        assert.equal(active.items[0].effective_access, true); assert.deepEqual(active.items[0].scope, ['assessment']);
        stage = 'withdraw'; await page.evaluate(() => document.querySelector('#clinicalHistory article button').click());
        await page.waitForFunction(() => document.querySelector('#clinicalHistory article')?.textContent.includes('已撤回') && !document.querySelector('#clinicalShell').hasAttribute('aria-busy'), { timeout: 30000 });
        const withdrawn = await api(`/federated/projects/${project.id}/consent?patient_id=${pid}`, owner);
        assert.equal(withdrawn.items[0].status, 'withdrawn'); assert.equal(withdrawn.items[0].effective_access, false);
        assert.equal(posts.length, 2); assert.deepEqual(errors, []);
        console.log(JSON.stringify({ actual_chrome: true, actual_http: true, selected_scope: active.items[0].scope, frozen_project_revision: readProjectRevision, lost_ack_get_only: true, withdrawn: true, current_effective_access: false }));
    } catch (error) {
        console.log(JSON.stringify({ stage, page: await page?.evaluate(() => document.body.innerText.slice(-4000)).catch(() => null) })); throw error;
    } finally {
        await browser?.close(); server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(2000)]);
        if (log.trim()) console.log(log.slice(-1200));
    }
});
