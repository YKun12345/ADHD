const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./rendering-browser-harness.cjs');
const root = path.resolve(__dirname, '../..');
let harness;
after(async () => { await harness?.close(); });
const hostile = '<img src=x onerror="window.__xss=1">';
const relationship = { relationship_id: 21, relationship_revision: 2, patient_id: 8, doctor_user_id: 4, patient_actor_user_id: 3,
    scope: ['care'], can_send: true };
const original = { message_id: 50, client_message_id: 'synthetic-original', ...relationship, sender_user_id: 3, sender_kind: 'patient',
    content: hostile, confirmed: true, version: 1, legacy: false, submission_status: 'committed', sent_at: '2026-10-16T04:00:00Z',
    content_digest: 'a'.repeat(64), context_digest: 'b'.repeat(64), send_context_digest: 'c'.repeat(64),
    sender_identity_basis: 'self:3:access:1:revision:1', read_receipts: [], viewer_read_at: null };
test('pages expose scoped messages with live status and no retired unscoped composer', () => {
    for (const file of ['patient-web/patient_messages.html', 'doctor-web/doctor_messages.html']) {
        assert.equal(fs.existsSync(path.join(root, file)), true, file);
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        assert.match(source, /shared-message-view\.js/); assert.match(source, /role="status"/);
        assert.doesNotMatch(source, /<textarea|sendPatientMessage|sendDoctorMessage/);
    }
});
test('existing web entries retire unscoped send handlers and link the working scoped view', () => {
    for (const [page,script,method] of [
        ['patient-web/patient_report.html','patient-web/js/report.js','sendPatientMessage'],
        ['doctor-web/doctor_patients.html','doctor-web/js/doctor_patients.js','sendDoctorMessage']]) {
        assert.match(fs.readFileSync(path.join(root,page),'utf8'), /(?:patient|doctor)_messages\.html/);
        assert.doesNotMatch(fs.readFileSync(path.join(root,script),'utf8'), new RegExp('\\.'+method+'\\('));
    }
});
async function open({ doctor = false, wrongDoctor = false, wrongViewer = false, delayList = false, history = false } = {}) {
    harness ||= await start();
    const page = await harness.page(doctor ? 'doctor-web/doctor_messages.html' : 'patient-web/patient_messages.html', null);
    await page.evaluate(doctor => {
        localStorage.setItem('smartbrain_token', 'synthetic-web-message-A');
        localStorage.setItem('smartbrain_user', JSON.stringify({ id: doctor ? 4 : 3, role: doctor ? 'researcher' : 'patient', patient_profile: doctor ? null : { id: 8 } }));
        window.SMARTBRAIN_API_BASE_URL = `${location.origin}/api/v1`;
        if (doctor) history.replaceState({}, '', '?patient_id=8');
    }, doctor);
    let read = false;
    const calls = [], pending = {};
    page.removeAllListeners('request'); page.on('request', request => {
        const url = new URL(request.url()); if (!url.pathname.startsWith('/api/v1/')) return request.abort();
        calls.push({ route: url.pathname + url.search, method: request.method() });
        const send = (data, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
        if (url.pathname.endsWith('/identity/context')) return send({ accessible_patients: [{ patient_id: 8, display_name: '合成消息档案' }] });
        if (url.pathname.endsWith('/my_patients')) return send({ items: [{ patient_id: 8, patient_name: '合成消息档案' }] });
        if (url.pathname.endsWith('/relationships')) return send({ items: [{ ...relationship, doctor_user_id: wrongDoctor ? 99 : 4, can_send: !history }] });
        if (url.pathname.endsWith('/50/read')) {
            read = !wrongViewer;
            return send({ message_id: 50, viewer_user_id: wrongViewer ? 99 : doctor ? 4 : 3, read_at: '2026-10-16T04:02:00Z' });
        }
        if (url.pathname.endsWith('/shared-messages')) {
            const viewer = doctor ? 4 : 3;
            const row = { ...original, read_receipts: read ? [{ message_id: 50, viewer_user_id: viewer, read_at: '2026-10-16T04:02:00Z' }] : [],
                viewer_read_at: read ? '2026-10-16T04:02:00Z' : null };
            if (delayList) { pending.list = () => send({ items: [row] }); return; }
            return send({ items: [row] });
        }
        return send({ detail: 'Unexpected route' }, 500);
    });
    for (const file of [(doctor ? 'doctor-web' : 'patient-web') + '/js/session-guard.js',
        (doctor ? 'doctor-web' : 'patient-web') + '/js/api.js', 'doctor-web/js/shared-message-view.js']) {
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), 'utf8') });
    }
    return { page, calls, pending };
}
const loaded = page => page.waitForFunction(() => document.querySelector('#messageStatus').textContent.includes('已读取接收关系'));
test('patient chooses one actual relationship, safely reads hostile text and records only its own read receipt', async () => {
    const { page, calls } = await open();
    try {
        await loaded(page); assert.equal(calls.some(row => row.route.includes('relationship_id=')), false);
        await page.select('#messageRelationship', '21'); await page.waitForSelector('[data-message-read="50"]');
        const content = await page.$eval('#messageItems', node => ({ text: node.textContent, attacks: node.querySelectorAll('img,script,[onerror]').length }));
        assert.ok(content.text.includes(hostile)); assert.equal(content.attacks, 0); assert.equal(await page.evaluate(() => window.__xss), 0);
        await page.click('[data-message-read="50"]');
        await page.waitForFunction(() => document.querySelector('#messageStatus').textContent.includes('不代表专业处理'));
        assert.match(await page.$eval('#messageItems', node => node.textContent), /我已查看/);
        assert.deepEqual(calls.filter(row => row.method === 'POST').map(row => row.route), ['/api/v1/care/shared-messages/50/read']);
        assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => /message|owned/.test(key))), false);
    } finally { await page.close(); }
});
test('doctor scope rejects another original doctor and does not fetch its message body', async () => {
    const { page, calls } = await open({ doctor: true, wrongDoctor: true });
    try {
        await page.waitForFunction(() => document.querySelector('#messageStatus').textContent.includes('不一致'));
        assert.equal(await page.$('[data-message-read]'), null);
        assert.equal(calls.some(row => row.route.includes('relationship_id=')), false);
    } finally { await page.close(); }
});
test('wrong actual viewer receipt is rejected without claiming this account has read', async () => {
    const { page } = await open({ wrongViewer: true });
    try {
        await loaded(page); await page.select('#messageRelationship', '21'); await page.waitForSelector('[data-message-read="50"]');
        await page.click('[data-message-read="50"]');
        await page.waitForFunction(() => document.querySelector('#messageStatus').textContent.includes('不一致'));
        assert.doesNotMatch(await page.$eval('#messageItems', node => node.textContent), /我已查看/);
    } finally { await page.close(); }
});
test('historical relationship remains explicitly readonly and late message data cannot restore a hidden page', async () => {
    const { page, pending } = await open({ history: true, delayList: true });
    try {
        await loaded(page); assert.match(await page.$eval('#messageRelationship', node => node.textContent), /仅查看历史/);
        await page.select('#messageRelationship', '21');
        for (let i = 0; i < 100 && !pending.list; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(pending.list);
        await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
        await pending.list(); await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(await page.$eval('#messageItems', node => node.textContent), '');
        assert.equal(await page.$eval('#messageRelationship', node => node.options.length), 0);
    } finally { await page.close(); }
});
