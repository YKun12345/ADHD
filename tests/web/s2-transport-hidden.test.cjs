const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

test('pending originals resolving after hide do not repopulate the stopped daily page', async () => {
    class Element {
        constructor(tag, text) { this.tagName = tag.toUpperCase(); this.textContent = text || ''; this.children = []; this.dataset = {}; }
        append(...children) { this.children.push(...children); }
        replaceChildren(...children) { this.children = children; }
        setAttribute() {} addEventListener() {} querySelectorAll() { return []; }
    }
    const elements = {};
    for (const id of ['clinicalShell', 'clinicalStatus', 'clinicalInputs', 'clinicalHistory', 'clinicalPending', 'clinicalRefresh']) elements[id] = new Element('div');
    const listeners = {}; let release;
    const originalPromise = new Promise(resolve => { release = resolve; });
    const session = { accountId: 1, role: 'patient', token: 'test-only-token' };
    const context = {
        window: { __originals: originalPromise, SessionGuard: {
            captureSession: () => session, isCurrentSession: () => true, onInvalidated() {}
        }, addEventListener() {} },
        document: { hidden: false, getElementById: id => elements[id], createElement: tag => new Element(tag),
            addEventListener(name, callback) { listeners[name] = callback; } },
        location: { search: '?patient_id=2&cycle_id=3' }, URLSearchParams, crypto: webcrypto
    };
    const source = fs.readFileSync(path.resolve(__dirname, '../../doctor-web/js/clinical-business.js'), 'utf8');
    // Stub only the durable-storage dependency. The production lifecycle and
    // pendingView implementation execute unchanged; no browser DB is opened.
    const isolated = source.replace(/        async function originals\(\) \{[\s\S]*?\n        async function save\(entry\)/,
        '        async function originals() { return await window.__originals; }\n        async function save(entry)');
    assert.notEqual(isolated, source, 'the storage seam must still match the production source');
    vm.createContext(context); vm.runInContext(isolated, context);
    const page = context.window.ClinicalBusiness.makePage('cycle', ['patient']);
    const loading = page.pendingView();
    context.document.hidden = true; listeners.visibilitychange();
    assert.equal(elements.clinicalPending.children.length, 0, 'hide clears the current pending view');
    release([{ label: '真实日期记录', id: 'daily-test-original', payload: { content: { note: 'private original' } } }]);
    await loading;
    assert.equal(page.current(0), false);
    assert.equal(elements.clinicalPending.children.length, 0, 'an older storage read must not restore private pending metadata');
    assert.equal(page.pending, false, 'hidden cleanup must not restore decrypted originals in the page state');
});
