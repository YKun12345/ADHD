// Actual mini controllers + request + HTTP + isolated synthetic DB; no native WeChat claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '../..');
const evidence = path.join(root, 'docs/evidence');
const child = process.argv.includes('--child');
const receipt = child ? 'w04-mobile-child-submission' : 'w04-mobile-submission';
const { createHarness } = require('../../miniprogram/tests/helpers/cognitive-harness');
const { COLORS } = require('../../miniprogram/utils/stroop-test');
const tap = dataset => ({ currentTarget: { dataset } });
function jsonRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method || 'GET', headers: options.headers || {} }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', value => { text += value; });
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300,
        json: async () => JSON.parse(text) }));
    });
    req.on('error', reject); req.end(options.body);
  });
}

function execute(h, page, task) {
  if (task === 'reaction') {
    while (page.data.running) {
      const i = page.data.currentTrialIndex;
      h.advance([800, 1000, 1200, 1400][i % 4]);
      assert.equal(page.data.phase, 'stimulus');
      if (page.data.stimulusType === 'go') { h.advance(100); page.handleTestTap(tap({ trial: page.data.currentTrialNumber })); }
      else h.advance(page._config.responseWindowMs);
      h.advance(450);
    }
  } else if (task === 'stroop' || task === 'flanker') {
    while (page.data.running) {
      h.advance(100);
      const dataset = task === 'stroop' ? { key: COLORS.find(color => color.hex === page.data.currentColorHex).key, trial: page.data.currentTrialNumber }
        : { direction: page.data.stimulusText.trim().split(/\s+/)[2] === '←' ? 'left' : 'right', trial: page.data.currentTrial };
      page.handleAnswer(tap(dataset));
      h.advance(task === 'stroop' ? 350 : 250);
    }
  } else if (task === 'nback') {
    const positions = [];
    while (page.data.running) {
      const position = page.data.grid.find(cell => cell.active).index, index = positions.length;
      positions.push(position); h.advance(100);
      if (index < 2) page.handleCellTap(tap({ index: position, trial: page.data.currentTrial }));
      else page.handleAnswer(tap({ match: position === positions[index - 2], trial: page.data.currentTrial }));
      if (page.data.running) h.advance(400);
    }
  } else if (task === 'trail') {
    while (page.data.running) {
      const order = page._sequence.slice();
      for (const label of order) { h.advance(100); page.handleNodeTap(tap({ label, tapToken: page.data.tapToken })); }
      if (page.data.phase === 'transition') h.advance(2000);
    }
  } else {
    for (let count = 0; page.data.running && count < 100; count++) {
      if (page.data.phase === 'direction-change') h.advance(1500);
      const digits = [];
      while (page.data.phase === 'presenting') {
        if (page.data.shownDigit !== '') digits.push(Number(page.data.shownDigit));
        h.advance(page._config.digitDurationMs + page._config.gapMs);
      }
      assert.equal(page.data.phase, 'recall');
      if (page.data.directionText === '倒背') digits.reverse();
      digits.forEach(digit => page.handleDigitTap(tap({ digit, trial: page.data.currentTrial })));
      page.submitAnswer(tap({ trial: page.data.currentTrial }));
      if (page.data.phase === 'feedback') h.advance(450);
    }
    assert.equal(page.data.running, false);
  }
}

async function run() {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(__dirname, 'isolated_authorization_server.py'), String(port)],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '', h, browser, offline = false, loseAck = false;
  const pending = new Set(), results = [], transports = [];
  server.stdout.on('data', value => { serverLog += value; }); server.stderr.on('data', value => { serverLog += value; });
  const record = (scenario, extra = {}) => { results.push({ scenario, passed: true, ...extra }); console.log('PASS ' + scenario); };
  const api = async (route, auth, body, expected = 200) => {
    const response = await jsonRequest(`${origin}/api/v1${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
        ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w02-local-synthetic-fixture-only' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(value)}`); return value;
  };
  const drain = async () => { while (pending.size) await Promise.allSettled([...pending]); await Promise.resolve(); await Promise.resolve(); };
  try {
    for (let i = 0; i < 300; i++) {
      if (server.exitCode !== null) throw new Error('Isolated server failed: ' + serverLog);
      try { if ((await jsonRequest(origin)).ok) break; } catch (_) {}
      if (i === 299) throw new Error('Isolated server startup timeout');
      await pause(100);
    }
    const auth = await api('/auth/register', null, { email: 'w04-controller@example.org', full_name: '合成正式评估用户',
      password: 'Synthetic#2026', role: 'patient', consent_agreed: true,
      patient_profile: child ? { age: 10, patient_type: 'child', display_name: '合成正式评估儿童' } : { age: 26, patient_type: 'adult' },
      ...(child ? { guardian: { age: 36, relation: 'parent', proof_reference: 'synthetic-w04-controller-proof', confirmed: true } } : {}) }, 201);
    if (child) {
      const reviewer = await api('/auth/register', null, { email: 'w04-controller-reviewer@example.org', full_name: '合成监护核验人员',
        password: 'Synthetic#2026', role: 'researcher', consent_agreed: false }, 201);
      await api('/__synthetic__/authority', null, { user_id: reviewer.user.id, reviewer: true });
      const relationship = (await api('/identity/context', auth)).guardian_relationships[0];
      await api(`/__synthetic__/assign-guardian/${relationship.id}`, null, {});
      await api(`/identity/guardians/${relationship.id}/review`, reviewer, { expected_revision: relationship.revision, status: 'verified',
        review_reference: 'synthetic-w04-approved-proof', expires_at: '2090-01-01T00:00:00Z' });
      const patientId = (await api('/identity/context', auth)).accessible_patients[0].patient_id;
      await api('/patient/consents', auth, { patient_id: patientId, purpose: 'basic_use', scope: ['profile', 'assessment', 'tracking', 'care', 'imaging'], terms_version: 'W02-1' }, 201);
    }
    const pid = (await api('/identity/context', auth)).accessible_patients[0].patient_id;
    const template = (await api(`/care/assessment-templates?patient_id=${pid}`, auth)).items[0];
    let assessment = await api('/care/patient/assessments', auth, { patient_id: pid, template_id: template.id,
      template_version: template.version, previous_assessment_id: null, background: {} }, 201);
    h = createHarness(); Object.assign(h.storage, { current_user: auth.user, access_token: auth.access_token, api_base_url: `${origin}/api/v1` });
    delete require.cache[require.resolve('../../miniprogram/utils/request')];
    wx.showToast = () => {};
    wx.getSystemInfoSync = () => ({ platform: 'devtools', model: 'synthetic controller bridge', windowWidth: 390, windowHeight: 844 });
    wx.request = options => {
      const operation = (async () => {
        if (offline) { options.fail({ errMsg: 'synthetic offline' }); return; }
        const response = await jsonRequest(options.url, { method: options.method, headers: options.header,
          ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }) });
        const data = await response.json(); transports.push({ route: new URL(options.url).pathname, status: response.status, data: options.data, response: data });
        if (loseAck && options.method === 'POST' && options.url.endsWith('/care/submissions') && response.status === 201) {
          loseAck = false; options.fail({ errMsg: 'synthetic ACK lost after real commit' }); return;
        }
        options.success({ statusCode: response.status, data });
      })().catch(error => options.fail({ errMsg: String(error) }));
      pending.add(operation); operation.then(() => pending.delete(operation));
    };
    const load = async key => {
      assessment = await api(`/care/assessments/${assessment.id}`, auth);
      const item = assessment.items.find(row => row.key === key), observed = require('../../miniprogram/utils/assessment-execution').observeDevice();
      const attempt = await api(`/care/assessment-items/${item.id}/attempts`, auth, { expected_item_version: item.version,
        protocol_id: item.protocol_id, protocol_schema_version: item.protocol_schema_version, config_digest: item.config_digest,
        performer_patient_id: item.kind === 'scale' ? null : pid, respondent_kind: item.respondent_kind, confirmed: true,
        ...observed, practice: { completed: false, attempts: 0, exposure_count: 0 }, assistance: { provided: false, kind: 'none' }, recall_window: item.recall_window }, 201);
      const route = { ASRS: 'scale', SNAP_IV: 'scale', reaction: 'cognitive', digit: 'digit-span' }[key] || key;
      const page = h.load(route, { ageGroup: child ? 'child' : 'adult', query: { assessment_id: String(assessment.id), item_id: String(item.id), attempt_id: String(attempt.id) } });
      await page._loadPromise; assert.equal(page.data.executionError || page.data.unsupportedMessage || '', '');
      return { page, item, attempt };
    };
    const scale = await load(child ? 'SNAP_IV' : 'ASRS'), questions = child ? 26 : 18;
    for (let i = 0; i < questions; i++) { scale.page.selectOption(tap({ value: 1 })); if (i < questions - 1) scale.page.goNext(); }
    await scale.page.submitScale(); await drain();
    assert.equal(scale.page.data.formalCommitted, true); assert.equal(scale.page.data.result.total_score, questions);
    const scaleEvidence = await api(`/care/submissions/wx-${scale.attempt.run_id}/evidence`, auth);
    assert.equal(scaleEvidence.context.performer_user_id, auth.user.id); assert.equal(scaleEvidence.context.performer_patient_id, null);
    assert.equal(scaleEvidence.context.respondent_kind, child ? 'primary_guardian' : 'self');
    record('actual scale controller submits its immutable server attempt and reads the same persisted scored evidence');
    scale.page.onUnload();
    for (const task of ['reaction', 'stroop', 'flanker', 'nback', 'trail', 'digit']) {
      const { page, attempt } = await load(task);
      h.start(page); execute(h, page, task); assert.equal(page.data.practicePassed, true, task + ' practice');
      assert.equal(page.data.practiceFinished, true); page.handlePracticeContinue(); execute(h, page, task); await drain();
      assert.equal(page.data.phase, 'result'); assert.match(page.data.syncStatus, /^已提交/, task + ': ' + page.data.syncStatus);
      const original = await api(`/care/submissions/wx-${attempt.run_id}/evidence`, auth);
      assert.equal(original.server_result.legacy, false); assert.equal(original.ack.execution_status, 'submitted');
      assert.equal(original.ack.quality_status, 'limited'); // The controlled devtools bridge declares unknown input truthfully.
      assert.ok(original.ack.quality_reasons.includes('unknown_input'));
      assert.equal(original.execution_metadata.practice_records.length, 1);
      assert.equal(original.context.performer_patient_id, pid); assert.equal(original.context.performer_user_id, null);
      record(`actual ${task} practice/formal controller and request persist server-recalculated evidence`, { quality: original.ack.quality_status,
        practice_trials: original.execution_metadata.practice_records[0].trials.length, formal_trials: original.client_evidence.result_json.trials.length });
      page.onUnload();
    }
    const lost = await load('flanker');
    h.start(lost.page); execute(h, lost.page, 'flanker'); lost.page.handlePracticeContinue(); loseAck = true;
    execute(h, lost.page, 'flanker'); await drain();
    assert.equal(require('../../miniprogram/utils/submission-queue').pendingEntries().length, 1);
    lost.page.onUnload();
    assert.equal(await require('../../miniprogram/utils/submission-queue').queryQueuedStatus(`wx-${lost.attempt.run_id}`), true);
    assert.equal(require('../../miniprogram/utils/submission-queue').pendingEntries().length, 0);
    record('a real committed ACK lost in transport is recovered by the exact original submission status query after page closure');
    const current = await api(`/care/assessments/${assessment.id}`, auth);
    assert.equal(current.status, 'active');
    assert.ok(current.items.filter(row => row.kind === 'cognitive').every(row => row.execution_status === 'submitted' && row.quality_status === 'limited'));
    assert.equal(transports.some(row => row.route.endsWith('/patient/submit_cognitive_test') || row.route.endsWith('/patient/submit_scale')), false);
    record('actual limited simulator evidence never becomes materials-ready and no formal result uses a legacy submit route');
    const offlineRuns = [];
    for (let i = 0; i < 2; i++) {
      const execution = await load('flanker');
      h.start(execution.page); execute(h, execution.page, 'flanker'); execution.page.handlePracticeContinue();
      offline = true; execute(h, execution.page, 'flanker'); await drain(); offline = false;
      assert.equal(execution.page.data.syncStatus, '待同步');
      offlineRuns.push(execution.attempt.run_id); execution.page.onUnload();
    }
    const queue = require('../../miniprogram/utils/submission-queue');
    assert.equal(queue.pendingEntries().length, 2);
    assert.equal(await queue.syncQueued(`wx-${offlineRuns[1]}`), true);
    assert.deepEqual(queue.pendingEntries().map(row => row.payload.run_id), [offlineRuns[0]]);
    assert.equal(await queue.syncQueued(`wx-${offlineRuns[0]}`), true);
    assert.equal(queue.pendingEntries().length, 0);
    record('two actual offline formal runs survive closed controllers; only the second ACK removes the second run, and the original first run then submits');
    const blocked = await load('flanker');
    h.start(blocked.page); execute(h, blocked.page, 'flanker'); blocked.page.handlePracticeContinue();
    offline = true; execute(h, blocked.page, 'flanker'); await drain(); offline = false; blocked.page.onUnload();
    const basic = (await api('/patient/consents', auth)).items.find(row => row.purpose === 'basic_use' && row.effective_access);
    await api(`/patient/consents/${basic.id}/withdraw`, auth, { expected_revision: basic.revision });
    assert.equal(await queue.syncQueued(`wx-${blocked.attempt.run_id}`), false);
    assert.equal(queue.pendingEntries()[0].status, 'authorization_blocked');
    const before = transports.length; assert.equal(await queue.retryPending(), 0); assert.equal(transports.length, before);
    record('actual consent withdrawal rejects the original queued formal run and stops automatic retry without rebinding the result');
    h.restore(); // Browser/network timers must use the actual clock, not the task-controller clock.
    browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
      userDataDir: path.join(root, '.codex-tmp', `w04-submission-browser-${port}`), args: ['--no-first-run', '--disable-background-networking', '--disable-sync'] });
    const page = await browser.newPage(), pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.setViewport({ width: 1200, height: 1000 });
    await page.evaluateOnNewDocument(base => { window.SMARTBRAIN_API_BASE_URL = base + '/api/v1'; }, origin);
    await page.setRequestInterception(true);
    page.on('request', request => request.url().startsWith(origin) || request.url().startsWith('data:') ? request.continue() : request.abort());
    await page.goto(origin + '/patient-web/login.html', { waitUntil: 'domcontentloaded' });
    await page.type('#emailInput', auth.user.email); await page.type('#passwordInput', 'Synthetic#2026');
    await page.click('#patientConsentWrap .checkmark');
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#submitBtn')]);
    await page.goto(origin + '/patient-web/patient_assessments.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`[data-assessment-id="${assessment.id}"]`);
    await page.click(`[data-assessment-id="${assessment.id}"]`);
    await page.waitForFunction(() => document.querySelector('#assessmentDetails').textContent.includes('已提交'));
    const visible = await page.$eval('#assessmentDetails', element => element.textContent);
    assert.ok(visible.includes('有局限')); assert.ok(!visible.includes('医生已验收'));
    assert.doesNotMatch(visible, /当前提交尚未开放/, '已提交的真实资料不能仍显示全局尚未开放');
    assert.equal(await page.$eval('#createAssessmentButton', element => element.disabled), true);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: path.join(evidence, child ? 'w04-browser-child-submissions.png' : 'w04-browser-real-submissions.png'), fullPage: true });
    record('actual Chrome page reads persisted submitted/limited states and keeps creation disabled after basic withdrawal', { page_errors: pageErrors.length });
    fs.writeFileSync(path.join(evidence, `${receipt}-workflow.json`), JSON.stringify({ scope: 'actual mini controller/request/HTTP, temporary DB and separate synthetic ledger; controlled wx, not native WeChat', age_group: child ? 'child' : 'adult',
      passed: results.length, results, transport_requests: transports.length, real_data_used: false }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(evidence, `${receipt}-workflow-failed.json`), JSON.stringify({ results, error: String(error),
      last_transports: transports.slice(-3).map(row => ({ route: row.route, status: row.status, response: row.response })), serverLog }, null, 2));
    throw error;
  } finally { if (h) h.restore(); if (browser) await browser.close(); server.kill(); fs.writeFileSync(path.join(evidence, `${receipt}-server.txt`), serverLog); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
