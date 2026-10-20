const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer-core');

const root = path.resolve(__dirname, '../..');
const privateText = 'SYNTHETIC_A_PRIVATE_CHAT';

// Real page markup and scripts in Chrome; API responses are synthetic and delayed.
// No business API server, database, model or external service is opened.
test('delayed copilot initialization cannot recreate A chat after B login invalidates the page', async t => {
    let browser;
    const apiTimers = new Set();
    let apiCount = 0;
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname.startsWith('/api/v1/')) {
            apiCount++;
            const timer = setTimeout(() => {
                apiTimers.delete(timer);
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ items: [], completed_count: 0, total_days: 14 }));
            }, 2500);
            apiTimers.add(timer);
            return;
        }
        const file = path.resolve(root, '.' + url.pathname);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            response.writeHead(404); response.end(); return;
        }
        // Optional immutable pre-fix snapshot verifies the same test's red phase.
        const source = url.pathname === '/patient-web/js/patient_copilot.js' && process.env.W01_COPILOT_REVIEW_SOURCE
            ? path.resolve(process.env.W01_COPILOT_REVIEW_SOURCE) : file;
        const contentType = file.endsWith('.html') ? 'text/html; charset=utf-8'
            : file.endsWith('.js') ? 'application/javascript'
                : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        response.end(fs.readFileSync(source));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
        fs.mkdirSync(path.join(root, '.codex-tmp'), { recursive: true });
        browser = await puppeteer.launch({
            executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
            headless: true,
            userDataDir: fs.mkdtempSync(path.join(root, '.codex-tmp/w01-copilot-review-')),
            args: ['--disable-gpu', '--no-first-run', '--disable-background-networking'],
            timeout: 20000
        });
        const context = await browser.createBrowserContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.setRequestInterception(true);
        page.on('request', request => request.url().startsWith(origin) || request.url().startsWith('data:')
            ? request.continue() : request.abort());
        await page.evaluateOnNewDocument(base => {
            window.SMARTBRAIN_API_BASE_URL = `${base}/api/v1`;
            localStorage.setItem('smartbrain_user', JSON.stringify({ id: 101, role: 'patient',
                subrole: null, full_name: 'Synthetic A', patient_profile: { id: 201 } }));
            localStorage.setItem('smartbrain_token', 'synthetic-A');
            localStorage.setItem('smartbrain_patient_copilot_history_101',
                JSON.stringify([{ role: 'user', content: 'SYNTHETIC_A_PRIVATE_CHAT' }]));
            const nativeFetch = window.fetch.bind(window);
            window.__reviewApiStarted = 0;
            window.__reviewApiPending = 0;
            window.fetch = async (url, options) => {
                if (!String(url).startsWith(`${base}/api/v1/`)) return nativeFetch(url, options);
                window.__reviewApiStarted++;
                window.__reviewApiPending++;
                try { return await nativeFetch(url, options); }
                finally { window.__reviewApiPending--; }
            };
        }, origin);
        await page.goto(`${origin}/patient-web/patient_tracking.html`, { waitUntil: 'domcontentloaded' });
        // Tracking starts two requests and its copilot starts the same two requests.
        await page.waitForFunction(() => window.__reviewApiStarted >= 4, { timeout: 10000 });
        const loginTab = await context.newPage();
        await loginTab.setRequestInterception(true);
        loginTab.on('request', request => request.url().startsWith(origin) ? request.continue() : request.abort());
        await loginTab.goto(`${origin}/patient-web/login.html`, { waitUntil: 'domcontentloaded' });
        await loginTab.evaluate(() => SessionGuard.establishSession('synthetic-B', {
            id: 102, role: 'patient', subrole: null, full_name: 'Synthetic B', patient_profile: { id: 202 }
        }, SessionGuard.captureSession()));
        await page.waitForSelector('[data-session-invalid="true"]', { timeout: 10000 });
        await page.waitForFunction(() => window.__reviewApiPending === 0, { timeout: 10000 });
        // Allow the rejected-request continuations and their DOM work to finish.
        await new Promise(resolve => setTimeout(resolve, 300));
        const before = await page.evaluate(() => ({
            invalid: !!document.querySelector('[data-session-invalid]'),
            assistantAppended: !!document.querySelector('#pageCopilotBubble'),
            current: JSON.parse(localStorage.getItem('smartbrain_user')).id,
            bodyChildren: document.body.children.length
        }));
        if (before.assistantAppended) await page.$eval('#openPageCopilotDrawerBtn', node => node.click());
        const after = await page.evaluate(secret => ({
            invalid: !!document.querySelector('[data-session-invalid]'),
            oldChat: document.querySelector('#pageCopilotMessages')?.textContent || '',
            oldContentInBody: document.body.textContent.includes(secret),
            current: JSON.parse(localStorage.getItem('smartbrain_user')).id
        }), privateText);
        t.diagnostic(JSON.stringify({ apiCount, before, after, errors }));
        assert.equal(before.current, 102, 'B credentials must remain current');
        assert.equal(before.invalid, true, 'A page must remain invalid');
        assert.equal(before.assistantAppended, false, 'A delayed initializer must not append an assistant after invalidation');
        assert.equal(after.oldContentInBody, false, 'A private chat must not return to the invalidated DOM');
    } finally {
        if (browser) await browser.close();
        for (const timer of apiTimers) clearTimeout(timer);
        await new Promise(resolve => server.close(resolve));
    }
});
