const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const flow = require('../../patient-web/js/agent-flow.js');

const source = fs.readFileSync(path.resolve(__dirname, '../../patient-web/js/agent-companion-ui.js'), 'utf8');
const fingerprint = 'a'.repeat(64);

function harness(cardTop) {
    class Element {
        constructor(tag, text) {
            this.tagName = tag.toUpperCase(); this.textContent = text || ''; this.children = [];
            this.dataset = {}; this.value = tag === 'select' ? 'local' : ''; this.hidden = false;
            this.parentElement = null; this.style = {}; this.isConnected = true;
        }
        append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        setAttribute() {} insertBefore() {} after() {} before() {} addEventListener() {}
        querySelectorAll(selector) {
            const attribute = /^\[data-([a-z-]+)\]$/.exec(selector);
            const key = attribute?.[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            const matches = child => selector === 'input' ? child.tagName === 'INPUT' :
                selector === 'p' ? child.tagName === 'P' : key ? Object.hasOwn(child.dataset, key) : false;
            return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        height() { return this.children.length ? this.children.reduce((sum, child) => sum + child.height() + 4, 0) : 32; }
        getBoundingClientRect() {
            const top = this.id === 'agentCompanion' ? cardTop : this.parentElement ?
                this.parentElement.getBoundingClientRect().top + this.parentElement.children.slice(0, this.parentElement.children.indexOf(this)).reduce((sum, child) => sum + child.height() + 4, 0) : cardTop;
            const height = this.height();
            return { top, bottom: top + height, left: 0, right: 400, width: 400, height };
        }
        getClientRects() { return [this.getBoundingClientRect()]; }
    }
    const elements = {};
    for (const id of ['agentForm', 'agentInput', 'agentIntent', 'agentActions']) {
        elements[id] = new Element('div'); elements[id].parentElement = new Element('div');
    }
    elements.agentIntent.value = 'question';
    const calls = [], listeners = {};
    const document = { hidden: false, addEventListener(name, callback) { listeners[name] = callback; } };
    const context = {
        window: { AgentFlow: flow, addEventListener(name, callback) { listeners[name] = callback; } },
        document, innerHeight: 600, innerWidth: 800, crypto: webcrypto, URLSearchParams,
        IntersectionObserver: class { observe() {} disconnect() {} },
        requestAnimationFrame: callback => setImmediate(callback), cancelAnimationFrame: clearImmediate,
        setTimeout, clearTimeout, Event: class {},
        getComputedStyle: () => ({ visibility: 'visible', display: 'block' })
    };
    vm.createContext(context); vm.runInContext(source, context);
    const ui = context.window.createAgentCompanionUI({
        $: id => elements[id], node: (tag, text) => new Element(tag, text),
        api: { observe: async value => { calls.push(value); return { observed: true, fingerprint }; } },
        doctor: false, session: {}, owner: () => ({ accountId: 1, role: 'patient', patientId: 2, revision: 1 }),
        current: () => true, locked: () => false, request: async () => {}, message: () => {}
    });
    return { ui, calls, listeners };
}

function showUpdates(ui) {
    ui.actions({ items: [], companion: {
        protocol: 'Xingzai-flow-1', fingerprint, title: '本轮进展', summary: '当前已保存材料的摘要',
        observation_context: 'test-only-context', updates: [{ id: 'b'.repeat(64), text: '尚未进入视口的实际变化' }]
    } });
}

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

test('a card title entering the viewport does not acknowledge unseen update text', async () => {
    const { ui, calls } = harness(599);
    showUpdates(ui); await flush();
    assert.equal(calls.length, 0, 'the title is only partly visible and every update remains below the viewport');
});

test('a fully visible summary and update can acknowledge the exact displayed fingerprint', async () => {
    const { ui, calls } = harness(0);
    showUpdates(ui); await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].patient_id, 2);
    assert.equal(calls[0].observation_context, 'test-only-context');
});
