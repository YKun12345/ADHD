const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./rendering-browser-harness.cjs');
let harness;
before(async () => { harness = await start(); });
after(async () => { await harness?.close(); });

async function open({ role = 'patient', pageRole = role, withheld = false } = {}) {
    const page = await harness.page(pageRole === 'researcher' ? 'doctor-web/doctor_assessments.html' : 'patient-web/patient_assessments.html', null);
    await page.evaluate(({ role, withheld }) => {
        if (role === 'researcher') history.replaceState({}, '', '?patient_id=8');
        localStorage.setItem('smartbrain_token', 'w03-quality-synthetic-A');
        localStorage.setItem('smartbrain_user', JSON.stringify({ id: 3, role, patient_profile: { id: 8 } }));
        window.__qualityCalls = [];
        const session = { id: 50, patient_id: 8, source: 'self', status: 'active', version: 1, responsible_doctor_id: null,
            background_visibility: withheld ? 'withheld' : 'shared', background: withheld ? {} : { sleep: { status: 'provided', value: 'SYNTHETIC PRIVATE BACKGROUND' } },
            items: [{ id: 51, title: 'Synthetic item', kind: 'scale', protocol_id: 'project-legacy-scale-v1', execution_status: 'not_started',
                quality_status: 'pending_validation', acceptance_status: 'not_required', attempts: [], allowed_actions: [] }], allowed_actions: [] };
        window.API.Authorization = { getContext: async () => { window.__qualityCalls.push('context'); return { accessible_patients: [{ patient_id: 8, display_name: 'Synthetic A', patient_type: 'adult' }] }; } };
        window.API.Assessment = {
            getTemplates: async () => { window.__qualityCalls.push('templates'); return { items: [] }; },
            list: async () => { window.__qualityCalls.push('list'); return { items: [session] }; },
            get: async () => { window.__qualityCalls.push('get'); return session; }
        };
    }, { role, withheld });
    const root = path.resolve(__dirname, '../..');
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, `${pageRole === 'researcher' ? 'doctor-web' : 'patient-web'}/js/session-guard.js`), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'doctor-web/js/assessment-page.js'), 'utf8') });
    await page.waitForFunction(() => !document.querySelector('#assessmentMessage').textContent.includes('正在'));
    return page;
}

test('quality actual page refuses a wrong role before invoking the assessment or profile APIs', async () => {
    const page = await open({ role: 'researcher', pageRole: 'patient' });
    try {
        assert.deepEqual(await page.evaluate(() => window.__qualityCalls), []);
        assert.equal(await page.$eval('#createAssessmentButton', node => node.disabled), true);
        assert.equal(await page.$eval('#assessmentDetails', node => node.textContent), '');
        assert.ok(await page.$eval('#assessmentMessage', node => node.textContent.includes('对应')));
    } finally { await page.close(); }
});

test('quality doctor renderer makes withheld background explicit and exposes no patient performer action', async () => {
    const page = await open({ role: 'researcher', withheld: true });
    try {
        await page.click('[data-assessment-id="50"]');
        await page.waitForFunction(() => document.querySelector('#assessmentDetails').textContent.includes('背景资料未共享'));
        const details = await page.$eval('#assessmentDetails', node => ({ text: node.textContent, buttons: [...node.querySelectorAll('button')].map(button => button.textContent) }));
        assert.ok(!details.text.includes('SYNTHETIC PRIVATE BACKGROUND'));
        assert.deepEqual(details.buttons, []);
    } finally { await page.close(); }
});

test('quality actual renderer can refresh after a same-session restored-page lifecycle', async () => {
    const page = await open();
    try {
        await page.click('[data-assessment-id="50"]');
        await page.waitForFunction(() => document.querySelector('#assessmentDetails').textContent.includes('SYNTHETIC PRIVATE BACKGROUND'));
        const beforeCalls = await page.evaluate(() => window.__qualityCalls.length);
        // Controlled native lifecycle events in real Chrome. This is not a claim
        // that the harness browser actually cached a physical navigation.
        await page.evaluate(() => {
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        });
        assert.equal(await page.$eval('#assessmentDetails', node => node.textContent), '');
        await page.click('#refreshAssessmentsButton');
        await page.waitForFunction(count => window.__qualityCalls.length > count, {}, beforeCalls);
        await page.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('已读取'), { timeout: 1500 });
        assert.ok(await page.$('[data-assessment-id="50"]'));
    } finally { await page.close(); }
});

test('quality an unfinished old read cannot restore sensitive details after pagehide and pageshow', async () => {
    const page = await open();
    try {
        await page.evaluate(() => {
            window.API.Assessment.get = async () => new Promise(resolve => { window.__qualityLateRead = resolve; });
        });
        await page.click('[data-assessment-id="50"]');
        await page.waitForFunction(() => typeof window.__qualityLateRead === 'function');
        await page.evaluate(() => {
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        });
        await page.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('已读取'));
        await page.evaluate(() => window.__qualityLateRead({ id: 50, patient_id: 8, source: 'self', status: 'active', version: 1,
            background: { sleep: { status: 'provided', value: 'LATE SYNTHETIC PRIVATE A' } }, items: [], allowed_actions: [] }));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        assert.equal(await page.$eval('#assessmentDetails', node => node.textContent), '');
        assert.equal(await page.evaluate(() => document.body.textContent.includes('LATE SYNTHETIC PRIVATE A')), false);
        assert.ok(await page.$('[data-assessment-id="50"]'));
    } finally { await page.close(); }
});

test('quality restored page after a B login stays scrubbed and cannot invoke the old A APIs', async () => {
    const page = await open();
    try {
        await page.click('[data-assessment-id="50"]');
        await page.waitForFunction(() => document.querySelector('#assessmentDetails').textContent.includes('SYNTHETIC PRIVATE BACKGROUND'));
        const beforeCalls = await page.evaluate(() => window.__qualityCalls.length);
        await page.evaluate(() => {
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
            localStorage.setItem('smartbrain_token', 'w03-quality-synthetic-B');
            localStorage.setItem('smartbrain_user', JSON.stringify({ id: 4, role: 'patient', patient_profile: { id: 9 } }));
            window.dispatchEvent(new StorageEvent('storage', { key: 'smartbrain_token' }));
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        });
        await page.waitForSelector('[data-session-invalid="true"]');
        assert.equal(await page.evaluate(() => window.__qualityCalls.length), beforeCalls);
        assert.equal(await page.evaluate(() => document.body.textContent.includes('SYNTHETIC PRIVATE BACKGROUND')), false);
        assert.equal(await page.evaluate(() => localStorage.getItem('smartbrain_token')), 'w03-quality-synthetic-B');
        assert.equal(await page.$('#assessmentDetails'), null);
    } finally { await page.close(); }
});

test('quality physical same-origin back navigation is distinguished from controlled lifecycle evidence', async t => {
    const page = await open();
    try {
        await page.evaluate(() => {
            window.__qualityPhysicalTransitions = [];
            for (const type of ['pagehide', 'pageshow']) window.addEventListener(type, event => window.__qualityPhysicalTransitions.push({ type, persisted: event.persisted }));
        });
        const original = page.url();
        await page.goto(new URL('/patient-web/patient_home.html', original).href);
        await page.goBack();
        const restored = await page.evaluate(() => ({ events: window.__qualityPhysicalTransitions || [], initialized: Array.isArray(window.__qualityCalls) }));
        if (!restored.initialized || !restored.events.some(event => event.type === 'pageshow' && event.persisted)) {
            t.diagnostic('Physical navigation was not restored from BFCache in this harness; controlled native event checks remain the validated boundary.');
            t.skip('Harness did not produce persisted=true physical back navigation.');
            return;
        }
        t.diagnostic(JSON.stringify(restored));
        await page.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('已读取'));
        await page.click('#refreshAssessmentsButton');
        await page.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('已读取'));
        assert.ok(await page.$('[data-assessment-id="50"]'));
    } finally { await page.close(); }
});
