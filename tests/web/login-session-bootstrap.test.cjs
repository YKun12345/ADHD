const assert = require('node:assert/strict');
const test = require('node:test');
const { tab, storage, identity, reply } = require('./session-harness.cjs');

for (const kind of ['patient-web', 'doctor-web']) {
    test(`${kind}: login recovers when the initial session script did not load`, async () => {
        const sent = [];
        const a = tab(kind, storage(), async (url, options) => {
            sent.push({ url, options });
            return reply(200, { access_token: 'synthetic-login', user: identity(101, 'researcher') });
        }, 'login.html', { omitGuard: true });
        let scriptCount = 0;
        a.context.document.head.appendChild = script => {
            scriptCount++;
            assert.equal(new URL(script.src).pathname, `/${kind}/js/session-guard.js`);
            assert.ok(new URL(script.src).search, 'recovery must request a versioned dependency');
            setImmediate(() => { a.load(`${kind}/js/session-guard.js`); script.onload(); });
        };
        const result = await a.window.API.Auth.login({ identifier: 'synthetic@example.com', password: 'Synthetic-Login!1', role: 'researcher' });
        const guard = a.window.SessionGuard;
        guard.establishSession(result.access_token, result.user, guard.captureSession());
        assert.equal(scriptCount, 1);
        assert.equal(sent.length, 1);
        assert.equal(guard.captureSession().accountId, 101);
        assert.equal(sent[0].options.headers.Authorization, undefined);
    });

    test(`${kind}: a failed dependency does not send credentials and allows a retry`, async () => {
        let requestCount = 0;
        const a = tab(kind, storage(), async () => { requestCount++; return reply(200, {}); }, 'login.html', { omitGuard: true });
        let attempt = 0;
        a.context.document.head.appendChild = script => {
            setImmediate(() => {
                if (++attempt === 1) script.onerror();
                else { a.load(`${kind}/js/session-guard.js`); script.onload(); }
            });
        };
        await assert.rejects(a.window.API.Auth.login({ identifier: 'synthetic@example.com', password: 'Synthetic-Login!1' }), /登录组件|刷新/);
        assert.equal(requestCount, 0);
        await a.window.API.Auth.login({ identifier: 'synthetic@example.com', password: 'Synthetic-Login!1' });
        assert.equal(requestCount, 1);
        assert.equal(attempt, 2);
    });

    test(`${kind}: concurrent requests share one recovery script`, async () => {
        const a = tab(kind, storage(), async () => reply(200, {}), 'login.html', { omitGuard: true });
        let scriptCount = 0;
        a.context.document.head.appendChild = script => {
            scriptCount++;
            setImmediate(() => { a.load(`${kind}/js/session-guard.js`); script.onload(); });
        };
        await Promise.all([a.window.API.Auth.login({}), a.window.API.Auth.login({})]);
        assert.equal(scriptCount, 1);
    });

    test(`${kind}: loading the dependency twice keeps the current page session`, () => {
        const a = tab(kind, storage(), undefined, 'login.html');
        const guard = a.window.SessionGuard;
        const snapshot = guard.captureSession();
        a.load(`${kind}/js/session-guard.js`);
        assert.equal(a.window.SessionGuard, guard);
        assert.equal(guard.isCurrentSession(snapshot), true);
    });

    test(`${kind}: a data page cannot recover by adopting another account`, async () => {
        let sent = 0;
        const a = tab(kind, storage(), async () => { sent++; return reply(200, {}); }, 'page.html', { omitGuard: true });
        let scriptCount = 0;
        a.context.document.head.appendChild = () => { scriptCount++; };
        await assert.rejects(a.window.API.Patient.getDashboardStatus(), /登录组件|刷新/);
        await assert.rejects(a.window.API.Auth.login({}), /登录组件|刷新/);
        assert.equal(sent, 0);
        assert.equal(scriptCount, 0);
    });
}
