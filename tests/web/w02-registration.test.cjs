const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, ready } = require('./rendering-browser-harness.cjs');
let harness;
before(async () => { harness = await start(); });
after(async () => { await harness?.close(); });

for (const client of ['patient-web']) test(`${client} child registration submits separate guardian account and child profile`, async () => {
    const page = await harness.page(`${client}/login.html`, null);
    await page.evaluate(() => {
        localStorage.clear();
        window.registrationPayloads = [];
        window.API.Auth = { register: async payload => { window.registrationPayloads.push(payload); return {}; } };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../../', client, 'js/session-guard.js'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../../', client, 'js/login.js'), 'utf8') });
    await ready(page);
    await page.click('.segment-pill[data-role="patient"]');
    await page.click('#toRegisterBtn');
    await page.select('#patientTypeInput', 'child');
    const values = { fullNameInput: '合成儿童', emailInput: 'guardian@example.com', passwordInput: 'Synthetic#2026',
        confirmPasswordInput: 'Synthetic#2026', ageInput: '10', guardianNameInput: '合成监护人', guardianAgeInput: '35', proofReferenceInput: 'synthetic-institution-reference' };
    for (const [id, value] of Object.entries(values)) if (await page.$(`#${id}`)) await page.type(`#${id}`, value);
    await page.evaluate(() => {
        for (const id of ['patientConsentCheckbox', 'guardianConfirmedInput']) {
            const input = document.getElementById(id);
            if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
        }
    });
    await page.click('#submitBtn');
    await page.waitForFunction(() => window.registrationPayloads.length === 1);
    const result = await page.evaluate(() => window.registrationPayloads[0]);
    assert.equal(result.full_name, '合成监护人');
    assert.equal(result.patient_profile.display_name, '合成儿童');
    assert.equal(result.patient_profile.age, 10);
    assert.deepEqual(result.guardian, { age: 35, relation: 'parent', proof_reference: 'synthetic-institution-reference', confirmed: true });
    assert.equal(Object.hasOwn(result.guardian, 'status'), false);
    await page.close();
});
