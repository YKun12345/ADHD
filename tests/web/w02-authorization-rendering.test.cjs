const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, rendered } = require('./rendering-browser-harness.cjs');
let harness;
before(async () => { harness = await start(); });
after(async () => { await harness?.close(); });
const attack = '<img src=x onerror="window.__xss=1">';

async function pageFor(data = {}) {
    const page = await harness.page('patient-web/patient_profile.html', null);
    await page.evaluate(data => {
        localStorage.setItem('smartbrain_user', JSON.stringify({ id: 7, role: 'patient', full_name: 'Synthetic', patient_profile: { id: 3 } }));
        localStorage.setItem('smartbrain_token', 'synthetic-A');
        window.__authorizationCalls = []; window.__authorizationData = data;
        window.confirm = () => true;
        window.API.Authorization = {
            getContext: async () => ({ user_id: 7, accessible_patients: [{ patient_id: 3, display_name: data.name || 'Synthetic', access_kind: 'self' }], ...data.context }),
            getRelationships: async () => ({ items: data.relationships || [] }),
            getConsents: async () => ({ items: data.consents || [] }),
            invite: async body => { window.__authorizationCalls.push({ operation: 'invite', body }); },
            accept: async (id, revision) => { window.__authorizationCalls.push({ operation: 'accept', id, revision }); },
            revoke: async (id, revision) => { window.__authorizationCalls.push({ operation: 'revoke', id, revision }); },
            grant: async body => { window.__authorizationCalls.push({ operation: 'grant', body }); },
            withdraw: async (id, revision) => {
                window.__authorizationCalls.push({ operation: 'withdraw', id, revision });
                if (data.delayWithdraw) return new Promise(resolve => { window.__finishWithdrawal = resolve; });
                const row = data.consents.find(item => item.id === id); row.status = 'withdrawn'; row.revision += 1;
            }
        };
    }, data);
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../../patient-web/js/session-guard.js'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../../doctor-web/js/authorization-panel.js'), 'utf8') });
    await page.waitForFunction(() => document.querySelector('[data-authorization-action="refresh"]'));
    return page;
}

test('authorization names and purpose metadata remain literal text in actual Chrome', async () => {
    const page = await pageFor({ name: attack, relationships: [{ id: 9, status: 'pending', initiator_user_id: 8, doctor_name: attack, scope: ['care'], revision: 2 }],
        consents: [{ id: 12, status: 'active', purpose: attack, terms_version: attack, revision: 1 }] });
    const dom = await rendered(page, '[data-authorization-panel]');
    assert.ok(dom.text.includes(attack)); assert.equal(dom.injected, 0);
    assert.equal(await page.evaluate(() => window.__xss), 0);
    await page.click('[data-authorization-action="accept"]');
    await page.waitForFunction(() => document.querySelector('.authorization-status').textContent.includes('共享关系已确认'));
    assert.deepEqual(await page.evaluate(() => window.__authorizationCalls[0]), { operation: 'accept', id: 9, revision: 2 });
    await page.close();
});

test('pending guardian UI exposes review state and no child AI or consent grant', async () => {
    const page = await pageFor({ context: { accessible_patients: [], guardian_relationships: [{ id: 8, status: 'pending', proof_reference: attack }] } });
    assert.equal(await page.$('[data-authorization-action="grant-ai"]'), null);
    assert.equal(await page.$('[data-authorization-action="invite"]'), null);
    assert.ok((await rendered(page, '[data-authorization-panel]')).text.includes('待机构核验'));
    assert.equal(await page.evaluate(() => window.__xss), 0);
    await page.close();
});

test('a restored business grant denied by current authorization heads is never shown effective', async () => {
    const page = await pageFor({ consents: [{ id: 12, purpose: 'external_ai', status: 'active', revision: 1,
        effective_access: false, effective_status: 'denied', terms_version: 'W02-1' }] });
    assert.equal(await page.$('[data-consent-id="12"] [data-authorization-action="withdraw"]'), null);
    assert.ok((await rendered(page, '[data-consent-id="12"]')).text.includes('授权校验未通过'));
    await page.close();
});

test('a late withdrawal acknowledgement cannot rebuild private A details after B login', async () => {
    const page = await pageFor({ delayWithdraw: true, name: 'Private A details', consents: [{ id: 12, purpose: 'external_ai', status: 'active', revision: 4 }] });
    await page.click('[data-authorization-action="withdraw"]');
    await page.waitForFunction(() => Boolean(window.__finishWithdrawal));
    await page.evaluate(() => {
        localStorage.setItem('smartbrain_token', 'synthetic-B');
        localStorage.setItem('smartbrain_user', JSON.stringify({ id: 8, role: 'patient', patient_profile: { id: 4 } }));
        window.dispatchEvent(new StorageEvent('storage', { key: 'smartbrain_token' }));
        window.__finishWithdrawal({});
    });
    await page.waitForSelector('[data-session-invalid="true"]');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await page.$('[data-authorization-panel]'), null);
    assert.equal(await page.evaluate(() => document.body.textContent.includes('Private A details')), false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('smartbrain_user')).id), 8);
    await page.close();
});

test('an ineffective stored active relationship is labelled denied and pending remains confirmable', async () => {
    const page = await pageFor({ relationships: [
        { id: 9, status: 'active', effective_access: false, initiator_user_id: 8, doctor_name: 'Synthetic doctor', revision: 2, scope: ['care'] },
        { id: 10, status: 'pending', effective_access: false, initiator_user_id: 8, doctor_name: 'Pending doctor', revision: 1, scope: ['care'] }
    ] });
    assert.ok((await rendered(page, '[data-relationship-id="9"]')).text.includes('授权校验未通过'));
    assert.ok(await page.$('[data-relationship-id="10"] [data-authorization-action="accept"]'));
    await page.close();
});
