const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '../..');

// Real Chrome DOM, real renderer source, synthetic API responses only. The fixture
// retains the page markup but omits unrelated page scripts and remote resources.
async function start() {
    const server = http.createServer((req, res) => {
        const relative = new URL(req.url, 'http://localhost').pathname.slice(1);
        const file = path.resolve(root, relative);
        if (!file.startsWith(root + path.sep) || !file.endsWith('.html') || !fs.existsSync(file)) {
            res.writeHead(404); res.end(); return;
        }
        const html = fs.readFileSync(file, 'utf8')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<link\b[^>]*>/gi, '');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const candidates = [process.env.CHROME_BIN, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'];
    const executablePath = candidates.find(value => value && fs.existsSync(value));
    if (!executablePath) throw new Error('Set CHROME_BIN to a Chrome/Chromium executable');
    const browser = await puppeteer.launch({ executablePath, headless: true,
        args: ['--disable-gpu', '--no-first-run', '--disable-background-networking'],
        userDataDir: fs.mkdtempSync(path.join(root, '.codex-tmp/w01-rendering-browser-')) });
    async function page(pageFile, scriptFile, data = {}) {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', request => request.isNavigationRequest() || request.url().startsWith('data:')
            ? request.continue() : request.abort());
        await page.goto(`http://127.0.0.1:${server.address().port}/${pageFile}`);
        await page.evaluate(data => {
            window.__xss = 0; window.__readyCallbacks = []; window.__fixture = data;
            const original = document.addEventListener.bind(document);
            document.addEventListener = (type, callback, options) => type === 'DOMContentLoaded'
                ? window.__readyCallbacks.push(callback) : original(type, callback, options);
            localStorage.clear();
            localStorage.setItem('smartbrain_user', JSON.stringify({ id: 9001, full_name: 'Synthetic user', role: 'researcher' }));
            window.API = {
                Model: { getAdmission: async () => data.modelAdmission || { inference_mode: 'real', status: 'unverified', real_inference_allowed: false,
                    message: 'Synthetic fixture: model provenance is unverified.' } },
                Doctor: { getMyPatients: async () => ({ items: data.patients || [] }),
                    predictTimeseries: async () => { if (data.predictionError) throw new Error(data.predictionError); return data.prediction; } },
                Patient: { getDashboardStatus: async () => data.dashboard || {}, getComprehensiveReport: async () => data.report || {} },
                Security: { getPatientOverview: async () => data.security || {} },
                Care: { getPatientTasksForDoctor: async () => ({ items: data.tasks || [] }),
                    getDoctorMessages: async () => ({ items: data.messages || [] }), getDoctorAiLogs: async () => ({ items: data.aiLogs || [] }),
                    getMyTasks: async () => ({ items: data.tasks || [] }), getPatientMessages: async () => ({ items: data.messages || [] }) },
                AI: { getStatus: async () => ({ configured: true, message: 'Synthetic API' }),
                    explainReport: async () => data.explanation || {}, chatMessage: async () => ({ reply: data.aiReply || '' }),
                    generateReminder: async () => data.reminder || {} }
            };
            window.echarts = { getInstanceByDom: () => null, init: () => ({ setOption() {}, resize() {} }),
                graphic: { LinearGradient: function () {} } };
        }, data);
        if (scriptFile?.endsWith('doctor_patients.js')) {
            await page.evaluate(patientId => {
                history.replaceState({}, '', `?focus_patient_id=${encodeURIComponent(patientId)}`);
                localStorage.setItem('smartbrain_token', 'synthetic-rendering-token');
            }, data.patients?.[0]?.patient_id || 7001);
            await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'doctor-web/js/session-guard.js'), 'utf8') });
        }
        if (scriptFile?.endsWith('patient_copilot.js')) {
            await page.evaluate(() => {
                localStorage.setItem('smartbrain_user', JSON.stringify({ id: 9001, full_name: 'Synthetic user', role: 'patient', patient_profile: { id: 7001 } }));
                localStorage.setItem('smartbrain_token', 'synthetic-rendering-token');
            });
            await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'patient-web/js/session-guard.js'), 'utf8') });
        }
        const helper = path.join(root, 'doctor-web/js/safe-rendering.js');
        if (fs.existsSync(helper)) await page.addScriptTag({ content: fs.readFileSync(helper, 'utf8') });
        let source = scriptFile ? fs.readFileSync(path.join(root, scriptFile), 'utf8') : '';
        // Rendering unit boundary only: omit static dependency imports in the module.
        // Functions under test and every other source statement remain unchanged.
        if (scriptFile?.endsWith('doctor_visualization.js')) source = source.replace(/^import .*;\s*$/gm, '');
        if (source) await page.addScriptTag({ content: source });
        return page;
    }
    return { page, async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}

async function ready(page) {
    await page.evaluate(async () => { for (const callback of window.__readyCallbacks) await callback(); });
}
async function rendered(page, selector) {
    return page.$eval(selector, node => ({ text: node.textContent, html: node.innerHTML,
        injected: node.querySelectorAll('img,script,svg,[onerror],[onload]').length }));
}
async function loadInline(page, pageFile) {
    const html = fs.readFileSync(path.join(root, pageFile), 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (!/\bsrc\s*=/.test(match[1]) && match[2].trim()) await page.addScriptTag({ content: match[2] });
    }
}
module.exports = { start, ready, rendered, loadInline };
