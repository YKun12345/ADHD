/* Local self/legacy data has an explicit owner. It never supplies formal task evidence. */
(() => {
    'use strict';
    const guard = window.SessionGuard;
    const snapshot = guard.captureSession();
    const legacyKeys = ['tempScaleAnswers_adult', 'tempScaleAnswers_child',
        'smartbrain_latest_cognitive_test', 'smartbrain_cognitive_test_history'];
    legacyKeys.forEach(key => localStorage.removeItem(key));
    // The old one-shot achievement flag had no owner and can survive a same-tab login.
    sessionStorage.removeItem('achievement_trigger');
    localStorage.removeItem('smartbrain_achievements_guest');
    localStorage.removeItem('smartbrain_ach_stats_guest');
    const owner = { accountId: snapshot.accountId, role: snapshot.role, subrole: snapshot.subrole,
        patientId: snapshot.patientId, sessionRevision: snapshot.revision };
    function canonical(context) {
        return JSON.stringify(Object.fromEntries(Object.entries(context).sort(([a], [b]) => a.localeCompare(b))));
    }
    function key(context) {
        guard.assertCurrentSession(snapshot);
        if (owner.accountId === null || owner.patientId === null || owner.role !== 'patient') throw new Error('请先登录并选择本人档案。');
        return `smartbrain_owned_v1:${owner.accountId}:${owner.patientId}:${encodeURIComponent(canonical(context))}`;
    }
    function record(context) {
        const name = key(context);
        try {
            const parsed = JSON.parse(localStorage.getItem(name) || 'null');
            if (parsed?.schema !== 1 || canonical(parsed.owner || {}) !== canonical(owner)
                || canonical(parsed.context || {}) !== canonical(context) || !parsed.createdAt || !parsed.updatedAt) return null;
            return parsed;
        } catch (_) { return null; }
    }
    function read(context) { return record(context)?.value ?? null; }
    function write(context, value) {
        const name = key(context);
        const previous = record(context);
        const now = new Date().toISOString();
        const data = { schema: 1, owner, context, createdAt: previous?.createdAt || now, updatedAt: now, value };
        try {
            localStorage.setItem(name, JSON.stringify(data));
            if (localStorage.getItem(name) !== JSON.stringify(data)) throw new Error('Storage did not acknowledge write');
        } catch (_) { throw new Error('本地保存失败，请检查浏览器存储空间；当前内容尚未保存。'); }
        return data;
    }
    function remove(context) { localStorage.removeItem(key(context)); }
    const achievementContext = Object.freeze({ kind: 'achievement_notice', mode: 'legacy_self',
        assessmentId: null, itemId: null, taskId: null, attemptId: null,
        protocolId: 'cognitive_preview', protocolVersion: 1, templateVersion: 'patient-web-cognitive-v1', respondent: 'self' });
    window.OwnedCache = { read, write, remove, achievementContext };
})();
