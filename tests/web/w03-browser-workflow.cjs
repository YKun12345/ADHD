// Actual business API and Chrome pages; temporary synthetic identity/ledger only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '../..'), evidence = path.join(root, 'docs/evidence');
const password = 'Synthetic#2026';

async function run() {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(__dirname, 'isolated_authorization_server.py'), String(port)],
        { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = '', browser;
    server.stdout.on('data', data => { serverLog += data; }); server.stderr.on('data', data => { serverLog += data; });
    const results = [], pageErrors = [], contexts = [];
    const record = scenario => { results.push({ scenario, passed: true }); console.log('PASS ' + scenario); };
    const api = async (route, auth, body, method = body === undefined ? 'GET' : 'POST', expected = 200) => {
        const response = await fetch(`${origin}/api/v1${route}`, { method,
            headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
                ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w02-local-synthetic-fixture-only' } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const result = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`); return result;
    };
    const register = (email, name, role = 'patient', extra = {}) => api('/auth/register', null, {
        email, full_name: name, password, role, consent_agreed: role === 'patient',
        ...(role === 'patient' ? { patient_profile: { age: 26, patient_type: 'adult' } } : {}), ...extra
    }, 'POST', 201);
    try {
        for (let n = 0; n < 300; n++) {
            if (server.exitCode !== null) throw new Error('Synthetic server failed: ' + serverLog);
            try { if ((await fetch(origin)).ok) break; } catch (_) {}
            if (n === 299) throw new Error('Synthetic server startup timeout');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const owner = await register('w03-browser-owner@example.org', '合成成人本人');
        const doctor = await register('w03-browser-doctor@example.org', '合成评估医生', 'researcher');
        const reviewer = await register('w03-browser-reviewer@example.org', '合成核验人员', 'researcher');
        await api('/__synthetic__/authority', null, { user_id: doctor.user.id });
        await api('/__synthetic__/authority', null, { user_id: reviewer.user.id, reviewer: true });
        const patientId = owner.user.patient_profile.id;
        browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
            userDataDir: path.join(root, '.codex-tmp', `w03-browser-${port}`), args: ['--no-first-run', '--disable-background-networking', '--disable-sync'] });
        const actorPage = async auth => {
            const context = await browser.createBrowserContext(); contexts.push(context);
            const page = await context.newPage(); await page.setViewport({ width: 1365, height: 1000 });
            page.on('pageerror', error => pageErrors.push(String(error))); page.on('dialog', dialog => dialog.accept());
            await page.evaluateOnNewDocument(origin => { window.SMARTBRAIN_API_BASE_URL = `${origin}/api/v1`; }, origin);
            await page.setRequestInterception(true);
            page.on('request', request => request.url().startsWith(origin) || request.url().startsWith('data:') || request.url() === 'about:blank' ? request.continue() : request.abort());
            await page.goto(`${origin}/patient-web/login.html`, { waitUntil: 'domcontentloaded' });
            if (auth.user.role === 'researcher') await page.click('.segment-pill[data-role="researcher"]');
            await page.type('#emailInput', auth.user.email); await page.type('#passwordInput', password);
            await page.click(auth.user.role === 'patient' ? '#patientConsentWrap .checkmark' : '#researcherConsentWrap .checkmark');
            await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#submitBtn')]);
            return page;
        };
        const ownerPage = await actorPage(owner);
        await ownerPage.goto(`${origin}/patient-web/patient_assessments.html`, { waitUntil: 'domcontentloaded' });
        await ownerPage.waitForFunction(() => !document.querySelector('#createAssessmentButton').disabled);
        await ownerPage.click('#createAssessmentButton');
        await ownerPage.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('本轮评估已保存'));
        let self = (await api(`/care/assessments?patient_id=${patientId}`, owner)).items[0];
        assert.equal(self.source, 'self'); assert.equal(self.responsible_doctor_id, null); assert.equal(self.status, 'active');
        assert.equal(self.items.length, 7); assert.ok(self.items.every(item => item.execution_status === 'not_started' && item.acceptance_status === 'not_required'));
        assert.ok(Object.values(self.background).every(field => field.status === 'skipped' && field.value === null));
        assert.equal((await api('/care/patient/tasks', owner)).items.length, 0);
        record('actual adult web creation persists seven self items with skipped background and no fake doctor or old task');
        await ownerPage.$eval('#assessmentDetails', element => Array.from(element.querySelectorAll('button')).find(button => button.textContent.includes('创建新尝试')).click());
        await ownerPage.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('新尝试已开始'));
        self = await api(`/care/assessments/${self.id}`, owner);
        let scale = self.items.find(item => item.kind === 'scale');
        assert.equal(scale.attempts.length, 1); assert.equal(scale.attempts[0].performer_kind, 'user');
        assert.equal(scale.attempts[0].performer_user_id, owner.user.id); assert.equal(scale.attempts[0].performer_patient_id, null);
        assert.equal(scale.attempts[0].execution_status, 'in_progress'); assert.equal(scale.attempts[0].quality_status, 'pending_validation');
        await ownerPage.$eval('#assessmentDetails', element => Array.from(element.querySelectorAll('button')).find(button => button.textContent.includes('创建新尝试')).click());
        await ownerPage.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('新尝试已开始'));
        self = await api(`/care/assessments/${self.id}`, owner); scale = self.items.find(item => item.kind === 'scale');
        assert.equal(scale.attempts.length, 2); assert.notEqual(scale.attempts[0].run_id, scale.attempts[1].run_id);
        await api('/patient/submit_cognitive_test', owner, { test_type: 'flanker', result_json: { test_run_id: scale.attempts[0].run_id, accuracy: 95 } }, 'POST', 409);
        await ownerPage.screenshot({ path: path.join(evidence, 'w03-browser-self.png'), fullPage: true });
        record('actual web starts distinct attempts with real executor metadata; reserved new run cannot use legacy submission');

        const invitation = await api('/care/relationships/invitations', doctor, { target_email: owner.user.email,
            scope: ['profile', 'assessment', 'tracking', 'care', 'imaging'], purpose: 'clinical_sharing' }, 'POST', 201);
        await api(`/care/relationships/${invitation.id}/accept`, owner, { expected_revision: invitation.revision });
        const doctorPage = await actorPage(doctor);
        await doctorPage.goto(`${origin}/doctor-web/doctor_assessments.html?patient_id=${patientId}`, { waitUntil: 'domcontentloaded' });
        await doctorPage.waitForFunction(() => !document.querySelector('#createAssessmentButton').disabled);
        await doctorPage.click('#createAssessmentButton');
        await doctorPage.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('本轮评估已保存'));
        const draft = (await api(`/care/assessments?patient_id=${patientId}`, doctor)).items.find(row => row.source === 'doctor_assigned');
        assert.equal(draft.status, 'draft'); await api(`/care/assessments/${draft.id}`, owner, undefined, 'GET', 403);
        assert.ok(!(await api(`/care/assessments?patient_id=${patientId}`, owner)).items.some(row => row.id === draft.id));
        await doctorPage.$eval('#assessmentDetails', element => Array.from(element.querySelectorAll('button')).find(button => button.textContent.includes('确认并发布')).click());
        await doctorPage.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('评估已发布'));
        const published = await api(`/care/assessments/${draft.id}`, owner);
        assert.equal(published.status, 'active'); assert.equal(published.responsible_doctor_id, doctor.user.id);
        const tasks = (await api('/care/patient/tasks', owner)).items.filter(item => item.assessment_id === published.id);
        assert.equal(tasks.length, 7); assert.ok(tasks.every(task => task.assessment_item_id && task.researcher_id === doctor.user.id && task.legacy === false));
        await api(`/care/patient/tasks/${tasks[0].id}/complete`, owner, {}, 'POST', 409);
        await doctorPage.screenshot({ path: path.join(evidence, 'w03-browser-doctor.png'), fullPage: true });
        record('actual doctor page saves private draft then publishes real linked tasks; manual old completion stays rejected');

        const guardian = await register('w03-browser-guardian@example.org', '合成监护人', 'patient', {
            patient_profile: { age: 10, patient_type: 'child', display_name: '合成被评估儿童' },
            guardian: { age: 36, relation: 'parent', proof_reference: 'synthetic-w03-child-proof', confirmed: true }
        });
        const pending = (await api('/identity/context', guardian)).guardian_relationships[0];
        await api('/__synthetic__/assign-guardian/' + pending.id, null, {});
        await api(`/identity/guardians/${pending.id}/review`, reviewer, { expected_revision: pending.revision, status: 'verified',
            review_reference: 'synthetic-w03-approved-proof', expires_at: '2090-01-01T00:00:00Z' });
        const child = (await api('/identity/context', guardian)).accessible_patients[0];
        await api('/patient/consents', guardian, { patient_id: child.patient_id, purpose: 'basic_use',
            scope: ['profile', 'assessment', 'tracking', 'care', 'imaging'], terms_version: 'W02-1' }, 'POST', 201);
        let pageDefinition;
        const storage = { api_base_url: `${origin}/api/v1`, access_token: guardian.access_token, current_user: guardian.user };
        global.wx = { getStorageSync: key => storage[key], showToast() {}, reLaunch() {}, navigateTo() {},
            getSystemInfoSync: () => ({ platform: 'devtools', model: 'synthetic browser bridge', windowWidth: 390, windowHeight: 844 }),
            request: options => { fetch(options.url, { method: options.method, headers: options.header,
                ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }) })
                .then(async response => options.success({ statusCode: response.status, data: await response.json() }))
                .catch(error => options.fail({ errMsg: String(error) })); } };
        global.Page = definition => { pageDefinition = definition; };
        require(path.join(root, 'miniprogram/pages/assessments/index.js'));
        const mobilePage = { ...pageDefinition, data: structuredClone(pageDefinition.data), setData(values) { Object.assign(this.data, values); } };
        await mobilePage.onLoad({}); assert.equal(mobilePage.data.patientName, '合成被评估儿童');
        assert.equal(await mobilePage.createAssessment(), true);
        const childAssessment = mobilePage.data.assessment; assert.equal(childAssessment.template_id, 'child-demo');
        mobilePage.setRespondentConfirmation({ detail: { value: ['confirmed'] } });
        const childScale = mobilePage.data.itemViews.find(item => item.kind === 'scale');
        assert.equal(await mobilePage.createAttempt({ currentTarget: { dataset: { id: childScale.id } } }), true);
        let childDetails = await api(`/care/assessments/${childAssessment.id}`, guardian);
        const observer = childDetails.items.find(item => item.kind === 'scale').attempts[0];
        assert.equal(observer.performer_user_id, guardian.user.id); assert.equal(observer.performer_patient_id, null);
        assert.equal(observer.respondent_user_id, guardian.user.id); assert.equal(observer.respondent_kind, 'primary_guardian');
        const cognitive = mobilePage.data.itemViews.find(item => item.kind === 'cognitive');
        assert.equal(await mobilePage.createAttempt({ currentTarget: { dataset: { id: cognitive.id } } }), true, mobilePage.data.errorText);
        childDetails = await api(`/care/assessments/${childAssessment.id}`, guardian);
        const executed = childDetails.items.find(item => item.id === cognitive.id).attempts[0];
        assert.equal(executed.performer_patient_id, child.patient_id); assert.equal(executed.performer_user_id, null);
        assert.equal(executed.actor_user_id, guardian.user.id); assert.equal(executed.submitter_user_id, guardian.user.id);
        assert.equal(executed.metadata.practice.completed, false); assert.equal(executed.metadata.timing.calibrated, false);
        assert.equal(executed.metadata.device.platform, 'miniprogram'); assert.equal(executed.metadata.device.environment, 'devtools');
        assert.equal(executed.metadata.device.device_type, 'simulator'); assert.equal(executed.metadata.input.method, 'unknown');
        record('actual mobile controller and request code create child assessment with guardian scale performer and child cognitive performer; controlled wx only');
        const childPage = await actorPage(guardian);
        await childPage.goto(`${origin}/patient-web/patient_assessments.html`, { waitUntil: 'domcontentloaded' });
        await childPage.waitForSelector(`[data-assessment-id="${childAssessment.id}"]`);
        await childPage.click(`[data-assessment-id="${childAssessment.id}"]`);
        await childPage.waitForFunction(() => document.querySelector('#assessmentDetails').textContent.includes('已开始'));
        assert.ok((await childPage.$eval('#assessmentSubject', element => element.textContent)).includes('合成被评估儿童'));
        assert.ok(!(await childPage.$eval('#assessmentDetails', element => element.textContent)).includes('医生已验收'));
        await childPage.screenshot({ path: path.join(evidence, 'w03-browser-child.png'), fullPage: true });
        record('actual child web reads the same persisted mobile attempts without turning them into submitted or accepted results');
        const basic = (await api(`/patient/consents?patient_id=${child.patient_id}`, guardian)).items.find(item => item.purpose === 'basic_use' && item.effective_access);
        await api(`/patient/consents/${basic.id}/withdraw`, guardian, { expected_revision: basic.revision });
        await mobilePage.reload(); assert.equal(mobilePage.data.canCreate, false);
        await childPage.reload({ waitUntil: 'domcontentloaded' });
        await childPage.waitForFunction(() => document.querySelector('#assessmentMessage').textContent.includes('已读取'));
        assert.equal(await childPage.$eval('#createAssessmentButton', node => node.disabled), true);
        const history = await api(`/care/assessments/${childAssessment.id}`, guardian);
        assert.ok(history.items.every(item => item.allowed_actions.length === 0));
        record('actual basic-use withdrawal disables both client creation hints and new attempts while own history stays readable');
        assert.deepEqual(pageErrors, []);
        fs.writeFileSync(path.join(evidence, 'w03-browser-workflow.json'), JSON.stringify({ passed: results.length, results, pageErrors,
            scope: 'Actual Chrome/API and mobile controller/request with controlled wx; synthetic temporary business DB and independent ledger, no device rendering or real clinical admission', browser: await browser.version() }, null, 2));
    } catch (error) {
        fs.writeFileSync(path.join(evidence, 'w03-browser-workflow-failed.json'), JSON.stringify({ results, pageErrors, error: String(error), serverLog }, null, 2));
        throw error;
    } finally {
        fs.writeFileSync(path.join(evidence, 'w03-browser-server.txt'), serverLog);
        for (const context of contexts) await context.close().catch(() => {});
        if (browser) await browser.close(); server.kill();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
