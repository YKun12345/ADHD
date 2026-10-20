const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../..');

function storage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key), key: index => [...values.keys()][index] ?? null,
        get length() { return values.size; }, values };
}
function identity(id, role = 'patient') {
    return { id, role, subrole: 'normal', full_name: `Synthetic ${id}`,
        patient_profile: role === 'patient' ? { id: id + 100, patient_type: 'adult' } : null };
}
function signIn(store, id, role = 'patient', token = `synthetic-token-${id}`) {
    store.setItem('smartbrain_token', token);
    store.setItem('smartbrain_user', JSON.stringify(identity(id, role)));
}
function tab(kind, store, fetch = async () => reply(200, {}), pageName = 'page.html', options = {}) {
    const listeners = {};
    const element = () => ({ textContent: '', append: () => {}, appendChild: () => {},
        replaceChildren: () => {}, setAttribute: () => {}, style: {}, dataset: {} });
    const body = element();
    const document = { body, head: element(), readyState: 'complete', createElement: element, querySelectorAll: () => [],
        querySelector: () => null, getElementById: () => null, addEventListener: () => {} };
    const window = { location: { protocol: 'http:', hostname: '127.0.0.1', port: '8000',
        origin: 'http://127.0.0.1:8000', pathname: `/${kind}/${pageName.split('?')[0]}`, search: pageName.includes('?') ? '?' + pageName.split('?')[1] : '',
        href: `http://127.0.0.1:8000/${kind}/${pageName}`, replace() {} },
        addEventListener(name, fn) { (listeners[name] ||= []).push(fn); }, dispatchEvent() {},
        setTimeout, clearTimeout, setInterval, clearInterval, document, fetch };
    const sessionStore = storage();
    const context = vm.createContext({ window, document, localStorage: store, sessionStorage: sessionStore, console, URL, URLSearchParams,
        crypto: { randomUUID }, AbortController, FormData, setTimeout, clearTimeout, setInterval, clearInterval,
        CustomEvent: class { constructor(type) { this.type = type; } }, alert: () => {}, confirm: () => true,
        fetch, Date, performance });
    window.window = window;
    Object.defineProperty(context, 'fetch', { get: () => window.fetch });
    const run = source => vm.runInContext(source, context);
    const load = relative => run(fs.readFileSync(path.join(root, relative), 'utf8'));
    const guardFile = `${kind}/js/session-guard.js`;
    if (!options.omitGuard && fs.existsSync(path.join(root, guardFile))) load(guardFile);
    load(`${kind}/js/api.js`);
    return { window, context, store, sessionStore, load, run, emit: (type, event = {}) => (listeners[type] || []).forEach(fn => fn(event)) };
}
function reply(status, value) {
    return { status, ok: status < 400, headers: { get: () => 'application/json' },
        json: async () => value, text: async () => JSON.stringify(value), clone() { return this; } };
}
module.exports = { tab, storage, identity, signIn, reply, root };
