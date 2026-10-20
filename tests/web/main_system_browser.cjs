// Real main-system forms and assessment pages, synthetic accounts only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '../..');
const store = path.join(root, '.codex-tmp/main-examples');
const evidence = path.join(root, 'docs/evidence/main-system-2026-10-18');
const origin = 'http://127.0.0.1:8000';

async function run() {
  const source = JSON.parse(fs.readFileSync(path.join(store, 'source.json'), 'utf8'));
  assert.equal(source.status, 'completed'); assert.equal(source.main_system, true);
  const errors = [], badCalls = [], calls = [], checks = {};
  const profile = fs.mkdtempSync(path.join(store, 'browser-'));
  let browser, stage = 'launch';
  try {
    browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      headless: true, userDataDir: profile, protocolTimeout: 60000,
      args: ['--no-first-run', '--disable-background-networking', '--disable-sync'] });
    for (const key of ['followup', 'review', 'doctor']) {
      stage = key + '-login';
      const page = await browser.newPage();
      await page.setViewport({ width: 1360, height: 960 });
      page.on('pageerror', error => errors.push({ stage, message: error.message }));
      page.on('dialog', dialog => dialog.dismiss());
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = request.url();
        if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return request.continue();
        if (new URL(url).origin === origin) return request.continue();
        if (new URL(url).pathname.startsWith('/api/v1/')) badCalls.push(new URL(url).origin + new URL(url).pathname);
        return request.abort();
      });
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/api/v1/')) calls.push({ key, path: url.pathname, status: response.status() });
      });
      const account = source.accounts[key], doctor = key === 'doctor';
      await page.goto(origin + (doctor ? '/doctor-web/login.html' : '/patient-web/login.html'), { waitUntil: 'domcontentloaded' });
      await page.click(`.segment-pill[data-role="${doctor ? 'researcher' : 'patient'}"]`);
      await page.type('#emailInput', account.email); await page.type('#passwordInput', account.password);
      if (doctor && !(await page.$eval('#researcherConsentCheckbox', input => input.checked))) await page.click('#researcherConsentWrap .checkmark');
      if (!doctor && !(await page.$eval('#patientConsentCheckbox', input => input.checked))) await page.click('#patientConsentWrap .checkmark');
      await page.waitForFunction(() => !document.querySelector('#submitBtn').disabled);
      const logged = page.waitForResponse(response => response.url() === origin + '/api/v1/auth/login' && response.request().method() === 'POST');
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#submitBtn')]);
      assert.equal((await logged).status(), 200);
      checks[key + '_login'] = await page.evaluate(() => {
        const user = JSON.parse(localStorage.getItem('smartbrain_user')); return { id: user.id, role: user.role };
      });
      assert.equal(checks[key + '_login'].id, account.user.id);
      stage = key + '-assessment';
      const scenario = source.scenarios[doctor ? 'review' : key];
      const target = doctor ? '/doctor-web/doctor_assessments.html' : '/patient-web/patient_assessments.html';
      await page.goto(origin + target + '?patient_id=' + scenario.patient_id, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.querySelector('#assessmentMessage')?.textContent.includes('已读取'));
      const state = await page.evaluate(() => ({ can_create: !document.querySelector('#createAssessmentButton').disabled,
        notice: document.querySelector('#assessmentAdmission').textContent,
        sessions: document.querySelectorAll('[data-assessment-id]').length }));
      assert.equal(state.can_create, true); assert.match(state.notice, /参考评估/); assert.ok(state.sessions >= 1);
      checks[key + '_assessment'] = state;
      await page.click(`[data-assessment-id="${scenario.assessment.id}"]`);
      await page.waitForFunction(() => document.querySelector('#assessmentDetails')?.textContent.includes('参考评估'));
      await page.screenshot({ path: path.join(evidence, key + '-main-assessment.png'), fullPage: true });
      await page.close();
    }
    assert.deepEqual(badCalls, []); assert.deepEqual(errors, []);
    assert.ok(calls.every(row => row.status < 400));
    const result = { status: 'passed', normal_login_forms: true, main_port: 8000, checks, errors,
      api_calls: calls.length, forbidden_service_calls: badCalls, synthetic_only: true };
    fs.writeFileSync(path.join(evidence, 'browser-receipt.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    fs.writeFileSync(path.join(evidence, 'browser-failure.json'), JSON.stringify({ stage, message: error.message, errors, calls }, null, 2));
    throw error;
  } finally { await browser?.close(); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
