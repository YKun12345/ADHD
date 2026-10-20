const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tab, storage, signIn, root } = require('./session-harness.cjs');

function cachePage(store) {
    const page = tab('patient-web', store);
    const cachePath = 'patient-web/js/owned-cache.js';
    if (fs.existsSync(path.join(root, cachePath))) page.load(cachePath);
    return page;
}
const context = { kind: 'scale_draft', mode: 'legacy_self', assessmentId: null, itemId: null,
    taskId: null, attemptId: null, protocolId: 'ASRS', protocolVersion: 1,
    templateVersion: 'patient-web-asrs-v1', respondent: 'self' };
test('anonymous scale/cognitive legacy keys are removed without adopting values', () => {
    const store = storage({ tempScaleAnswers_adult: '[4,4]', tempScaleAnswers_child: '[3]',
        smartbrain_latest_cognitive_test: '{"raw_result":{"accuracy":99}}', smartbrain_cognitive_test_history: '[{}]' });
    signIn(store, 2); const page = cachePage(store);
    assert.ok(page.window.OwnedCache, 'Owned cache must be connected');
    assert.equal(store.getItem('tempScaleAnswers_adult'), null);
    assert.equal(store.getItem('smartbrain_latest_cognitive_test'), null);
    assert.equal(page.window.OwnedCache.read(context), null);
});
test('draft includes identity, protocol, respondent and timestamps; only matching context resumes', () => {
    const store = storage(); signIn(store, 1); const page = cachePage(store);
    assert.ok(page.window.OwnedCache);
    page.window.OwnedCache.write(context, { answers: [1, 2] });
    assert.deepEqual(JSON.parse(JSON.stringify(page.window.OwnedCache.read(context))), { answers: [1, 2] });
    const raw = JSON.parse([...store.values.entries()].find(([key]) => key.startsWith('smartbrain_owned_v1:'))[1]);
    assert.equal(raw.owner.accountId, 1); assert.equal(raw.owner.patientId, 101);
    assert.equal(raw.context.protocolId, 'ASRS'); assert.equal(raw.context.respondent, 'self');
    assert.ok(raw.createdAt); assert.ok(raw.updatedAt);
    for (const changed of [{ taskId: 3 }, { assessmentId: 2 }, { attemptId: 4 },
        { templateVersion: 'v2' }, { respondent: 'parent' }]) {
        assert.equal(page.window.OwnedCache.read({ ...context, ...changed }), null);
    }
});
test('A draft is not readable by B and old A page cannot write with B credentials', () => {
    const store = storage(); signIn(store, 1); const a = cachePage(store);
    assert.ok(a.window.OwnedCache); a.window.OwnedCache.write(context, { answers: [1] });
    signIn(store, 2); const b = cachePage(store);
    assert.equal(b.window.OwnedCache.read(context), null);
    assert.throws(() => a.window.OwnedCache.write(context, { answers: [4] }), /会话|登录|账号/);
});
test('logout clears owned drafts; corrupt storage and mismatched owner are not resumed', () => {
    const store = storage(); signIn(store, 1); const page = cachePage(store);
    assert.ok(page.window.OwnedCache); page.window.OwnedCache.write(context, [1]);
    const key = [...store.values.keys()].find(key => key.startsWith('smartbrain_owned_v1:'));
    const record = JSON.parse(store.getItem(key)); record.owner.patientId = 999;
    store.setItem(key, JSON.stringify(record));
    assert.equal(page.window.OwnedCache.read(context), null);
    store.setItem(key, 'malformed'); assert.equal(page.window.OwnedCache.read(context), null);
    page.window.OwnedCache.write(context, [1]);
    page.window.SessionGuard.invalidateSession(page.window.SessionGuard.captureSession());
    assert.equal(store.getItem(key), null);
});
test('storage failure is reported and never displayed as saved', () => {
    const store = storage(); signIn(store, 1); const page = cachePage(store);
    assert.ok(page.window.OwnedCache);
    const original = store.setItem;
    store.setItem = (key, value) => { if (key.startsWith('smartbrain_owned_v1:')) throw new Error('QuotaExceeded'); original(key, value); };
    assert.throws(() => page.window.OwnedCache.write(context, [1]), /本地|保存|空间/);
});
test('anonymous achievement trigger is discarded before any account can consume it', () => {
    const store = storage(); signIn(store, 2); const page = tab('patient-web', store);
    page.sessionStore.setItem('achievement_trigger', '{"summary":"A private result"}');
    page.load('patient-web/js/owned-cache.js');
    assert.equal(page.sessionStore.getItem('achievement_trigger'), null);
});
test('achievement module uses page identity and cannot load B stats in old A page', () => {
    const store = storage(); signIn(store, 1); const page = tab('patient-web', store);
    page.load('patient-web/js/achievement.js');
    store.setItem('smartbrain_ach_stats_2', '{"totalSessions":777}');
    signIn(store, 2);
    assert.throws(() => page.window.Achievement.getStats(), /会话|登录|账号/);
});
