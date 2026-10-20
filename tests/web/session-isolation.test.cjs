const assert = require('node:assert/strict');
const test = require('node:test');
const { tab, storage, identity, signIn, reply } = require('./session-harness.cjs');

for (const kind of ['patient-web', 'doctor-web']) {
    const role = kind === 'patient-web' ? 'patient' : 'researcher';
    test(`${kind}: old page must not send new account token`, async () => {
        const store = storage(); signIn(store, 1, role);
        const sent = []; const a = tab(kind, store, async (_, config) => { sent.push(config); return reply(201, {}); });
        signIn(store, 2, role);
        await assert.rejects(a.window.API.Patient.submitScale({ answers: [1] }), /会话|登录|账号/);
        assert.equal(sent.length, 0);
    });
    for (const status of [200, 401]) {
        test(`${kind}: late ${status} must not expose A or clear B`, async () => {
            const store = storage(); signIn(store, 1, role);
            let finish; const a = tab(kind, store, () => new Promise(resolve => { finish = resolve; }));
            const pending = a.window.API.Patient.getComprehensiveReport();
            signIn(store, 2, role);
            finish(reply(status, status === 401 ? { detail: 'Token expired' } : { secret: 'A only' }));
            await assert.rejects(pending, /会话|登录|账号/);
            assert.equal(store.getItem('smartbrain_token'), 'synthetic-token-2');
            assert.equal(JSON.parse(store.getItem('smartbrain_user')).id, 2);
        });
    }
    test(`${kind}: logout and same account login change revision`, () => {
        const store = storage(); signIn(store, 1, role);
        const a = tab(kind, store);
        assert.ok(a.window.SessionGuard, 'Page session guard must be installed');
        const first = a.window.SessionGuard.captureSession();
        assert.equal(first.accountId, 1); assert.equal(first.role, role);
        a.window.SessionGuard.invalidateSession(first);
        const b = tab(kind, store, undefined, 'login.html');
        b.window.SessionGuard.establishSession('synthetic-token-1', identity(1, role), b.window.SessionGuard.captureSession());
        const second = b.window.SessionGuard.captureSession();
        assert.notEqual(first.revision, second.revision);
        assert.equal(a.window.SessionGuard.isCurrentSession(first), false);
        assert.equal(b.window.SessionGuard.isCurrentSession(second), true);
    });
    test(`${kind}: storage event aborts pending request and invalidates page`, async () => {
        const store = storage(); signIn(store, 1, role);
        let signal; const a = tab(kind, store, (_, config) => { signal = config.signal;
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
        const pending = a.window.API.Patient.getDashboardStatus();
        const snapshot = a.window.SessionGuard?.captureSession();
        signIn(store, 2, role); a.emit('storage', { key: 'smartbrain_user' });
        assert.equal(signal.aborted, true);
        await assert.rejects(pending, /会话|登录|账号/);
        assert.ok(a.window.SessionGuard, 'Guard required');
        assert.equal(a.window.SessionGuard.isCurrentSession(snapshot), false);
        assert.equal(a.window.SessionGuard.captureSession().accountId, 1, 'old page cannot rebind to B');
    });
    test(`${kind}: role and patient context changes invalidate page`, () => {
        const store = storage(); signIn(store, 1, role);
        const a = tab(kind, store); assert.ok(a.window.SessionGuard);
        const snapshot = a.window.SessionGuard.captureSession();
        if (role === 'patient') {
            const changed = identity(1, role); changed.patient_profile = { id: 999 };
            store.setItem('smartbrain_user', JSON.stringify(changed));
        } else store.setItem('smartbrain_selected_patient_id', '999');
        assert.equal(a.window.SessionGuard.isCurrentSession(snapshot), false);
    });
    test(`${kind}: direct imaging/fragment fetch cannot use a new session`, async () => {
        const store = storage(); signIn(store, 1, role);
        let count = 0; const a = tab(kind, store, async () => { count++; return reply(200, {}); });
        signIn(store, 2, role);
        await assert.rejects(a.window.fetch('/api/v1/imaging/session'), /会话|登录|账号/);
        assert.equal(count, 0);
    });
    test(`${kind}: account switch during response body decoding rejects old data`, async () => {
        const store = storage(); signIn(store, 1, role);
        let decode; const response = reply(200, {});
        response.json = () => new Promise(resolve => { decode = resolve; });
        const a = tab(kind, store, async () => response);
        const pending = a.window.API.Patient.getComprehensiveReport();
        await new Promise(resolve => setImmediate(resolve));
        signIn(store, 2, role); decode({ secret: 'A' });
        await assert.rejects(pending, /会话|登录|账号/);
        assert.equal(store.getItem('smartbrain_token'), 'synthetic-token-2');
    });
}
test('doctor dossier selected in URL is bound to the page and another dossier invalidates it', () => {
    const store = storage(); signIn(store, 1, 'researcher');
    const a = tab('doctor-web', store, undefined, 'doctor_report.html?patient_id=101');
    assert.equal(a.window.SessionGuard.captureSession().patientId, 101);
    const b = tab('doctor-web', store, undefined, 'doctor_report.html?patient_id=102');
    assert.equal(b.window.SessionGuard.captureSession().patientId, 102);
    a.emit('storage', { key: 'smartbrain_selected_patient_id' });
    assert.equal(a.window.SessionGuard.isCurrentSession(a.window.SessionGuard.captureSession()), false);
});
