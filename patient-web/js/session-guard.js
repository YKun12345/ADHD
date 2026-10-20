/* Page identity is fixed at load. A new login requires a new page or an explicit login action. */
(() => {
    'use strict';
    if (window.SessionGuard) return;
    const SESSION_KEY = 'smartbrain_session_v1';
    const TOKEN_KEY = 'smartbrain_token';
    const USER_KEY = 'smartbrain_user';
    const PATIENT_KEY = 'smartbrain_selected_patient_id';
    const PATIENT_OWNER_KEY = 'smartbrain_selected_patient_owner';
    const authKeys = new Set([SESSION_KEY, TOKEN_KEY, USER_KEY, PATIENT_KEY, PATIENT_OWNER_KEY]);
    const controllers = new Set();
    const callbacks = new Set();
    const timers = new Set();
    const intervals = new Set();
    const frames = new Set();
    let invalid = false;
    let notified = false;
    const newRevision = () => crypto.randomUUID();
    function parse(key) {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); }
        catch (_) { return null; }
    }
    function identity(user) {
        const selectionOwner = parse(PATIENT_OWNER_KEY);
        const patient = localStorage.getItem(PATIENT_KEY);
        const selected = selectionOwner?.accountId === user?.id && selectionOwner?.revision === parse(SESSION_KEY)?.revision
            && /^\d+$/.test(patient || '') ? Number(patient) : null;
        return { accountId: user?.id ?? null, role: user?.role ?? null, subrole: user?.subrole ?? null,
            patientId: user?.role === 'patient' ? user?.patient_profile?.id ?? null : selected };
    }
    function readSession() {
        return { ...identity(parse(USER_KEY)), token: localStorage.getItem(TOKEN_KEY),
            revision: parse(SESSION_KEY)?.revision ?? null };
    }
    function equal(a, b) {
        return ['accountId', 'role', 'subrole', 'patientId', 'token', 'revision'].every(key => a?.[key] === b?.[key]);
    }
    // Legacy credentials receive a revision, but anonymous health caches are never adopted.
    if (!parse(SESSION_KEY)?.revision) localStorage.setItem(SESSION_KEY, JSON.stringify({ revision: newRevision() }));
    // A doctor opens a dossier explicitly; legacy ambient selections with no owner are discarded.
    const initialUser = parse(USER_KEY);
    if (initialUser?.role === 'researcher') {
        const selectionOwner = parse(PATIENT_OWNER_KEY);
        if (selectionOwner?.accountId !== initialUser.id || selectionOwner?.revision !== parse(SESSION_KEY)?.revision) {
            localStorage.removeItem(PATIENT_KEY);
        }
        const query = new URLSearchParams(window.location.search || '');
        const selected = query.get('patient_id') || query.get('focus_patient_id');
        if (/^\d+$/.test(selected || '')) localStorage.setItem(PATIENT_KEY, selected);
        localStorage.setItem(PATIENT_OWNER_KEY, JSON.stringify({ accountId: initialUser.id, revision: parse(SESSION_KEY).revision }));
    }
    let pageSession = Object.freeze(readSession());
    const original = { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
        setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
        requestAnimationFrame: window.requestAnimationFrame?.bind(window), cancelAnimationFrame: window.cancelAnimationFrame?.bind(window) };

    function changedError() {
        const error = new Error('登录会话或档案已变化，请重新打开页面后继续。');
        error.code = 'SESSION_CHANGED';
        return error;
    }
    function hidePage() {
        if (notified) return;
        notified = true;
        if (!document.body) { document.addEventListener('DOMContentLoaded', hidePage, { once: true }); notified = false; return; }
        const notice = document.createElement('main');
        document.body.classList?.remove('ai-drawer-open');
        notice.setAttribute('role', 'alert');
        notice.setAttribute('data-session-invalid', 'true');
        notice.style.cssText = 'padding:48px;max-width:640px;margin:auto;font-family:sans-serif';
        const title = document.createElement('h1'); title.textContent = '登录会话已变化';
        const text = document.createElement('p'); text.textContent = '本页已停止读取和提交资料。请重新登录或从当前账号重新打开页面。';
        const link = document.createElement('a'); link.textContent = '重新打开登录页'; link.href = '../patient-web/login.html';
        notice.append(title, text, link);
        document.body.replaceChildren(notice);
    }
    function invalidatePage() {
        if (invalid) return;
        invalid = true;
        controllers.forEach(controller => controller.abort()); controllers.clear();
        timers.forEach(id => original.clearTimeout(id)); timers.clear();
        intervals.forEach(id => original.clearInterval(id)); intervals.clear();
        frames.forEach(id => original.cancelAnimationFrame?.(id)); frames.clear();
        callbacks.forEach(callback => { try { callback(); } catch (_) { /* Remaining cleanup must continue. */ } });
        hidePage();
    }
    function captureSession() { return pageSession; }
    function isCurrentSession(snapshot) {
        const current = !invalid && equal(snapshot, pageSession) && equal(snapshot, readSession());
        if (!current && equal(snapshot, pageSession)) invalidatePage();
        return current;
    }
    function assertCurrentSession(snapshot = pageSession) {
        if (!isCurrentSession(snapshot)) throw changedError();
        return snapshot;
    }
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('smartbrain-session') : null;
    function announce() { channel?.postMessage({ revision: pageSession.revision }); }
    function clearOwnedCaches(snapshot) {
        const prefix = `smartbrain_owned_v1:${snapshot.accountId}:`;
        const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
        keys.filter(key => key?.startsWith(prefix)).forEach(key => localStorage.removeItem(key));
        localStorage.removeItem('smartbrain_selected_patient_id');
        localStorage.removeItem(PATIENT_OWNER_KEY);
        sessionStorage.removeItem('achievement_trigger');
    }
    function invalidateSession(snapshot) {
        // Late 401/logout can hide its old page but cannot touch a newer account's credentials.
        if (!equal(snapshot, readSession()) || !equal(snapshot, pageSession)) {
            if (equal(snapshot, pageSession)) invalidatePage();
            return false;
        }
        clearOwnedCaches(snapshot);
        localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY);
        localStorage.setItem(SESSION_KEY, JSON.stringify({ revision: newRevision() }));
        channel?.postMessage({ revision: parse(SESSION_KEY).revision });
        invalidatePage();
        return true;
    }
    function establishSession(token, user, expected) {
        assertCurrentSession(expected);
        if (!token || !user?.id || !['patient', 'researcher'].includes(user.role)) throw new Error('登录响应缺少有效账号。');
        const loginPage = /\/login\.html$/.test(window.location.pathname);
        if (!loginPage) throw new Error('请从登录页建立新会话。');
        clearOwnedCaches(pageSession);
        localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user));
        localStorage.setItem(SESSION_KEY, JSON.stringify({ revision: newRevision() }));
        pageSession = Object.freeze(readSession());
        announce();
        return pageSession;
    }
    function updateUser(snapshot, user) {
        assertCurrentSession(snapshot);
        if (!Object.keys(identity(user)).every(key => identity(user)[key] === snapshot[key])) throw changedError();
        localStorage.setItem(USER_KEY, JSON.stringify(user));
    }
    function clearLoginSession(expected) {
        assertCurrentSession(expected);
        if (!/\/login\.html$/.test(window.location.pathname)) throw changedError();
        clearOwnedCaches(expected);
        localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY);
        localStorage.setItem(SESSION_KEY, JSON.stringify({ revision: newRevision() }));
        pageSession = Object.freeze(readSession());
        announce();
    }
    function trackRequest(controller, snapshot) {
        assertCurrentSession(snapshot); controllers.add(controller);
        return () => controllers.delete(controller);
    }
    function check() { isCurrentSession(pageSession); }
    window.addEventListener('storage', event => { if (event.key === null || authKeys.has(event.key)) check(); });
    window.addEventListener('focus', check); window.addEventListener('pageshow', check);
    if (channel) channel.onmessage = check;

    // Stop all page work, including cognitive timing, after a cross-tab account change.
    window.setTimeout = (callback, delay, ...args) => {
        const snapshot = assertCurrentSession();
        const id = original.setTimeout(() => { timers.delete(id); if (isCurrentSession(snapshot) && typeof callback === 'function') callback(...args); }, delay);
        timers.add(id); return id;
    };
    window.clearTimeout = id => { timers.delete(id); original.clearTimeout(id); };
    window.setInterval = (callback, delay, ...args) => {
        const snapshot = assertCurrentSession();
        const id = original.setInterval(() => { if (isCurrentSession(snapshot) && typeof callback === 'function') callback(...args); }, delay);
        intervals.add(id); return id;
    };
    window.clearInterval = id => { intervals.delete(id); original.clearInterval(id); };
    if (original.requestAnimationFrame) {
        window.requestAnimationFrame = callback => {
            const snapshot = assertCurrentSession();
            const id = original.requestAnimationFrame(time => { frames.delete(id); if (isCurrentSession(snapshot)) callback(time); });
            frames.add(id); return id;
        };
        window.cancelAnimationFrame = id => { frames.delete(id); original.cancelAnimationFrame(id); };
    }
    window.SessionGuard = { captureSession, isCurrentSession, invalidateSession, assertCurrentSession,
        establishSession, clearLoginSession, updateUser, trackRequest,
        onInvalidated(callback) { callbacks.add(callback); return () => callbacks.delete(callback); } };

    // The image workspace and its imported modules also fetch with an HttpOnly session.
    // Guard those real requests as well as the ordinary API wrapper.
    const nativeFetch = window.fetch.bind(window);
    function guardedResponse(response, snapshot) {
        return new Proxy(response, { get(target, name) {
            const value = Reflect.get(target, name, target);
            if (name === 'clone') return () => { assertCurrentSession(snapshot); return guardedResponse(target.clone(), snapshot); };
            if (['json', 'text', 'blob', 'arrayBuffer', 'formData'].includes(name)) return async (...args) => {
                assertCurrentSession(snapshot);
                const result = await value.apply(target, args);
                assertCurrentSession(snapshot);
                return result;
            };
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    }
    window.fetch = async (url, options = {}) => {
        const snapshot = captureSession(); assertCurrentSession(snapshot);
        const controller = new AbortController();
        const release = trackRequest(controller, snapshot);
        const signal = options.signal;
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        signal?.addEventListener('abort', abort, { once: true });
        try {
            const response = await nativeFetch(url, { ...options, signal: controller.signal });
            assertCurrentSession(snapshot);
            return guardedResponse(response, snapshot);
        } catch (error) {
            assertCurrentSession(snapshot);
            throw error;
        } finally {
            release(); signal?.removeEventListener('abort', abort);
        }
    };
})();
