const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(user, { profile = false, logoutError = false, freshUser = user } = {}) {
  function node(tag = 'div') {
    return { tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, hidden: false,
      textContent: '', className: '', style: {}, listeners: {},
      appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
      setAttribute(key, value) { this.attributes[key] = String(value); },
      getAttribute(key) { return this.attributes[key]; },
      querySelector(selector) { return selector === 'a' ? this.children.find(child => child.tagName === 'A') : null; },
      addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
      async emit(type, details = {}) { for (const handler of this.listeners[type] || []) await handler({ target: this, preventDefault() {}, ...details }); }
    };
  }
  const trigger = node(); trigger.className = 'user-profile';
  const elements = {};
  for (const id of ['accountLogout', 'accountRetry', 'accountName', 'accountUid', 'accountEmail', 'accountRole', 'accountStaffId', 'accountConsent', 'accountScope', 'accountAuditLink', 'accountStatus']) elements[id] = node();
  if (profile) { elements.accountProfile = node(); elements.accountProfile.dataset.accountRole = 'researcher'; }
  const handlers = {};
  const document = { readyState: 'loading', querySelectorAll: () => [trigger], getElementById: id => elements[id] || null,
    addEventListener(type, handler) { (handlers[type] ||= []).push(handler); },
    async emit(type) { for (const handler of handlers[type] || []) await handler(); } };
  const values = new Map([['smartbrain_user', typeof user === 'string' ? user : JSON.stringify(user)],
    ['smartbrain_token', 'synthetic-token'], ['smartbrain_selected_patient_id', '9'], ['unrelated_setting', 'keep']]);
  const localStorage = { getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key), setItem: (key, value) => values.set(key, value) };
  let logoutCalls = 0;
  const window = { location: { href: '', replace(url) { this.href = url; } }, API: { Auth: {
    async logout() { logoutCalls++; if (logoutError) throw new Error('offline'); }, async getMe() { return freshUser; }
  } } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../doctor-web/js/account.js'), 'utf8'), { document, localStorage, window, console: { warn() {} } });
  return { document, trigger, elements, values, window, logoutCalls: () => logoutCalls };
}

test('doctor account click and keyboard open the independent personal center', async () => {
  const f = fixture({ role: 'researcher', subrole: 'normal' });
  await f.document.emit('DOMContentLoaded');
  await f.trigger.emit('click');
  assert.equal(f.window.location.href, '../doctor-web/doctor_profile.html');
  for (const key of ['Enter', ' ']) { f.window.location.href = ''; await f.trigger.emit('keydown', { key }); assert.equal(f.window.location.href, '../doctor-web/doctor_profile.html'); }
});

test('patient account opens its original personal center', async () => {
  const f = fixture({ role: 'patient' }); await f.document.emit('DOMContentLoaded'); await f.trigger.emit('click');
  assert.equal(f.window.location.href, '../patient-web/patient_profile.html');
});

test('logout ends imaging session, clears credentials and returns to the original unified login', async () => {
  const f = fixture({ role: 'researcher' }); await f.document.emit('DOMContentLoaded');
  await f.elements.accountLogout.emit('click');
  assert.equal(f.logoutCalls(), 1);
  for (const key of ['smartbrain_user', 'smartbrain_token', 'smartbrain_selected_patient_id']) assert.equal(f.values.has(key), false);
  assert.equal(f.values.get('unrelated_setting'), 'keep');
  assert.equal(f.window.location.href, '../patient-web/login.html');
});

test('local logout works even when the backend cannot be reached', async () => {
  const f = fixture({ role: 'researcher' }, { logoutError: true }); await f.document.emit('DOMContentLoaded');
  await f.elements.accountLogout.emit('click');
  assert.equal(f.values.has('smartbrain_token'), false);
  assert.equal(f.window.location.href, '../patient-web/login.html');
});

test('broken saved user data returns to original login without breaking navigation', async () => {
  const f = fixture('{broken'); await f.document.emit('DOMContentLoaded'); await f.trigger.emit('click');
  assert.equal(f.window.location.href, '../patient-web/login.html');
});

test('repeated initialization does not double-bind navigation or logout', async () => {
  const f = fixture({ role: 'researcher' }); await f.document.emit('DOMContentLoaded'); await f.document.emit('DOMContentLoaded');
  assert.equal(f.trigger.listeners.click.length, 1);
  assert.equal(f.elements.accountLogout.listeners.click.length, 1);
});

test('personal center uses server identity and only shows audit entry to DAC', async () => {
  const user = { id: 12, email: 'fixture@example.org', full_name: '<img src=x onerror=alert(1)>', role: 'researcher', subrole: 'normal', consent_agreed: true };
  const f = fixture({ ...user, id: 99 }, { profile: true, freshUser: user }); await f.document.emit('DOMContentLoaded');
  assert.equal(f.elements.accountUid.textContent, 'UID: DR-12');
  assert.equal(f.elements.accountName.textContent, user.full_name);
  assert.equal(f.elements.accountAuditLink.hidden, true);
  const dac = fixture({ ...user, subrole: 'dac' }, { profile: true }); await dac.document.emit('DOMContentLoaded');
  assert.equal(dac.elements.accountAuditLink.hidden, false);
});
