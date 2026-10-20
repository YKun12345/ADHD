const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('ordinary menus remain compact; scoped research discovery and patient privacy retain exact consent entry', () => {
    const doctor = read('doctor-web/doctor_patients.html');
    const patient = read('patient-web/patient_profile.html');
    const privacy = read('miniprogram/pages/privacy-settings/index.wxml');
    assert.equal(/href=["']federated_workbench\.html/.test(doctor), false, 'ordinary doctor menu must omit the federated workbench');
    assert.equal(/href=["']patient_research_consent\.html/.test(patient), true, 'patient privacy must expose specific research consent and withdrawal');
    assert.equal(/bindtap=["']openResearchConsent/.test(privacy), true);
    assert.equal(/\/pages\/research-consent\/index/.test(read('miniprogram/pages/privacy-settings/index.js')), true);
    assert.match(doctor,/data-research-entry[^>]*hidden/);
    const entry=read('doctor-web/js/research-entry.js');
    assert.match(entry,/\/federated\/projects/);
    assert.match(entry,/!data\.projects\.length&&!data\.reviewer_institutions\.length/);
    assert.match(entry,/guard\.assertCurrentSession\(session\)/);
    assert.match(patient, /data-authorization-panel\s+data-authorization-role="patient"/);
    assert.match(privacy, /<authorization-panel role="patient"\s*\/>/);
    assert.ok(JSON.parse(read('miniprogram/app.json')).pages.includes('pages/research-consent/index'));
    assert.ok(fs.existsSync(path.join(root, 'doctor-web/federated_workbench.html')));
    assert.ok(fs.existsSync(path.join(root, 'patient-web/patient_research_consent.html')));
});
