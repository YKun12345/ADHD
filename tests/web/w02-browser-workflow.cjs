const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '../..'), evidence = path.join(root, 'docs/evidence');
const password = 'Synthetic#2026';
const attack = '<img src=x onerror="window.__w02Executed=1">';

async function run() {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(__dirname, 'isolated_authorization_server.py'), String(port)],
        { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', browser;
    server.stdout.on('data', value => { log += value; }); server.stderr.on('data', value => { log += value; });
    const results = [], errors = [], contexts = [];
    const record = (scenario, details = {}) => { results.push({ scenario, passed: true, ...details }); console.log(`PASS ${scenario}`); };
    try {
        for (let i = 0; i < 300; i++) {
            if (server.exitCode !== null) throw new Error('Isolated server failed: ' + log);
            try { if ((await fetch(origin)).ok) break; } catch (_) {}
            if (i === 299) throw new Error('Isolated server startup timed out');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const api = async (route, auth, data, method = data === undefined ? 'GET' : 'POST', expected = 200) => {
            const response = await fetch(`${origin}/api/v1${route}`, {
                method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
                    ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w02-local-synthetic-fixture-only' } : {}) },
                ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
            const body = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(body)}`); return body;
        };
        const register = (email, name, role = 'patient', extra = {}) => api('/auth/register', null, {
            email, full_name: name, password, role, consent_agreed: role === 'patient',
            ...(role === 'patient' ? { patient_profile: { age: 26, patient_type: 'adult' } } : {}), ...extra
        }, 'POST', 201);
        const owner = await register('w02-owner@example.org', attack);
        const doctor = await register('w02-doctor@example.org', '合成医生', 'researcher');
        const unverified = await register('w02-unverified@example.org', '未核验医生', 'researcher');
        const reviewer = await register('w02-reviewer@example.org', '合成机构核验员', 'researcher');
        await api('/__synthetic__/authority', null, { user_id: doctor.user.id });
        await api('/__synthetic__/authority', null, { user_id: reviewer.user.id, reviewer: true });
        const patientId = owner.user.patient_profile.id;
        await api('/care/relationships/invitations', unverified, { target_email: owner.user.email }, 'POST', 403);
        await api(`/ai-enhanced/patient/${patientId}/trend_predictions`, unverified, undefined, 'GET', 403);
        record('unverified technical researcher cannot invite or read cross-patient data');
        browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
            userDataDir: path.join(root, '.codex-tmp', `w02-browser-${port}`), args: ['--no-first-run', '--disable-background-networking', '--disable-sync'] });
        const openActor = async auth => {
            const context = await browser.createBrowserContext(); contexts.push(context);
            const page = await context.newPage(); await page.setViewport({ width: 1365, height: 1000 });
            page.on('pageerror', error => errors.push(String(error)));
            page.on('dialog', dialog => dialog.accept());
            await page.evaluateOnNewDocument(base => { window.SMARTBRAIN_API_BASE_URL = `${base}/api/v1`; window.__w02Executed = 0; }, origin);
            await page.setRequestInterception(true);
            page.on('request', request => request.url().startsWith(origin) || request.url().startsWith('data:') || request.url() === 'about:blank' ? request.continue() : request.abort());
            await page.goto(`${origin}/patient-web/login.html`, { waitUntil: 'domcontentloaded' });
            await page.bringToFront();
            if (auth.user.role === 'researcher') await page.click('.segment-pill[data-role="researcher"]');
            await page.type('#emailInput', auth.user.email); await page.type('#passwordInput', password);
            await page.click(auth.user.role === 'patient' ? '#patientConsentWrap .checkmark' : '#researcherConsentWrap .checkmark');
            await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#submitBtn')]);
            return page;
        };
        const profile = async (page, role) => {
            await page.bringToFront();
            await page.goto(`${origin}/${role === 'patient' ? 'patient-web/patient_profile.html' : 'doctor-web/doctor_profile.html'}`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-authorization-action="refresh"]');
        };
        const waitStatus = (page, text) => page.waitForFunction(text => document.querySelector('.authorization-status')?.textContent.includes(text), {}, text);
        const dPage = await openActor(doctor);
        await dPage.goto(`${origin}/doctor-web/doctor_patients.html`, { waitUntil: 'domcontentloaded' });
        await dPage.waitForSelector('[data-authorization-action="refresh"]');
        await dPage.type('#patientEmailInput', owner.user.email); await dPage.click('#bindPatientBtn');
        await dPage.waitForFunction(() => document.querySelector('#bindFeedback').textContent.includes('等待'));
        let relationship = (await api('/care/relationships', doctor)).items[0];
        assert.equal(relationship.status, 'pending');
        await api(`/care/doctor/patient/${patientId}/messages`, doctor, undefined, 'GET', 403);
        assert.equal(new URL(dPage.url()).searchParams.get('focus_patient_id'), null);
        record('actual doctor workbench sends pending invitation without automatic patient access');
        const pPage = await openActor(owner); await profile(pPage, 'patient');
        await pPage.click(`[data-relationship-id="${relationship.id}"] [data-authorization-action="accept"]`);
        await waitStatus(pPage, '共享关系已确认');
        relationship = (await api('/care/relationships', owner)).items[0]; assert.equal(relationship.status, 'active');
        const sent = await api(`/care/doctor/patient/${patientId}/messages`, doctor, { content: '明确共享的合成反馈', client_message_id: 'w02-browser-message' }, 'POST', 201);
        assert.ok(sent.id);
        await api(`/care/doctor/patient/${patientId}/ai_logs`, doctor, undefined, 'GET', 403);
        record('actual owner confirmation activates clinical sharing while private AI transcript stays denied');
        await dPage.bringToFront(); await dPage.reload({ waitUntil: 'domcontentloaded' });
        await dPage.waitForFunction(text => document.querySelector('#myPatientList').textContent.includes(text), {}, attack);
        assert.equal(await dPage.$eval('#myPatientList', node => node.querySelectorAll('img[onerror],svg[onload]').length), 0);
        assert.equal(await dPage.evaluate(() => window.__w02Executed), 0);
        record('real granted patient name remains literal in doctor workbench');
        const chat = await api('/ai/chat', owner, { message: '下一步怎样做', conversation: [], context_scope: 'general' });
        assert.equal(chat.provider, 'local');
        await api('/patient/submit_scale', owner, { scale_type: 'ASRS', respondent_type: 'self', answers: Array(18).fill(0) }, 'POST', 201);
        record('declining external AI still permits actual self scale submission and local assistance');
        await pPage.bringToFront(); await pPage.click('[data-authorization-action="grant-ai"]'); await waitStatus(pPage, '外部AI用途已单独确认');
        let aiConsent = (await api(`/patient/consents?patient_id=${patientId}`, owner)).items.find(row => row.purpose === 'external_ai');
        assert.equal(aiConsent.effective_access, true);
        await pPage.click(`[data-consent-id="${aiConsent.id}"] [data-authorization-action="withdraw"]`); await waitStatus(pPage, '用途同意已撤回');
        aiConsent = (await api(`/patient/consents?patient_id=${patientId}`, owner)).items.find(row => row.id === aiConsent.id);
        assert.equal(aiConsent.effective_access, false);
        await api('/patient/dashboard_status', owner);
        await pPage.evaluate(() => window.scrollTo(0, 0));
        await pPage.screenshot({ path: path.join(evidence, 'w02-browser-owner-authorizations.png'), fullPage: true });
        record('actual consent confirmation and withdrawal update authoritative state without stopping basic assessment');
        await pPage.click(`[data-relationship-id="${relationship.id}"] [data-authorization-action="revoke"]`); await waitStatus(pPage, '共享关系已撤回');
        await api(`/doctor/patient/${patientId}/report`, doctor, undefined, 'GET', 403);
        await api(`/care/doctor/patient/${patientId}/messages`, doctor, { content: '明确共享的合成反馈', client_message_id: 'w02-browser-message' }, 'POST', 403);
        await dPage.bringToFront(); await dPage.reload({ waitUntil: 'domcontentloaded' });
        await dPage.waitForFunction(() => document.querySelector('#myPatientList').children.length === 0 && document.querySelector('[data-authorization-action="refresh"]'));
        record('actual owner revocation blocks old doctor read and replay; workbench loses shared patient');
        const basic = (await api(`/patient/consents?patient_id=${patientId}`, owner)).items.find(row => row.purpose === 'basic_use' && row.effective_access);
        await pPage.bringToFront();
        await pPage.click(`[data-consent-id="${basic.id}"] [data-authorization-action="withdraw"]`); await waitStatus(pPage, '用途同意已撤回');
        await api('/patient/submit_scale', owner, { scale_type: 'ASRS', respondent_type: 'self', answers: Array(18).fill(0) }, 'POST', 403);
        assert.ok((await api('/patient/comprehensive_report', owner)).latest_scale);
        record('actual basic-use withdrawal blocks new submissions while retained own history remains readable');
        await pPage.click('[data-authorization-action="grant-basic"]'); await waitStatus(pPage, '基本使用同意已确认');
        await api('/patient/submit_scale', owner, { scale_type: 'ASRS', respondent_type: 'self', answers: Array(18).fill(0) }, 'POST', 201);
        record('actual explicit basic-use confirmation restores self submission with a new consent revision');
        const guardian = await register('w02-guardian@example.org', '合成监护人', 'patient', {
            patient_profile: { display_name: '合成儿童', age: 10, patient_type: 'child' },
            guardian: { age: 35, relation: 'parent', proof_reference: 'synthetic-proof-ref', confirmed: true }
        });
        const gPage = await openActor(guardian); await profile(gPage, 'patient');
        const gContext = await api('/identity/context', guardian); const guardianId = gContext.guardian_relationships[0].id;
        assert.deepEqual(gContext.accessible_patients, []);
        assert.equal(await gPage.$('[data-authorization-action="grant-ai"]'), null);
        await api('/patient/dashboard_status', guardian, undefined, 'GET', 403);
        record('actual pending guardian sees review state and cannot read or submit child data');
        await api(`/__synthetic__/assign-guardian/${guardianId}`, null, {});
        const rPage = await openActor(reviewer); await profile(rPage, 'researcher');
        await rPage.waitForSelector(`[data-guardian-id="${guardianId}"] [data-authorization-action="guardian-review"]`);
        await rPage.type(`[data-guardian-id="${guardianId}"] [data-authorization-input="review-reference"]`, 'synthetic-reviewed-reference');
        await rPage.click(`[data-guardian-id="${guardianId}"] [data-authorization-action="guardian-review"]`);
        await waitStatus(rPage, '监护关系状态已更新');
        const verified = await api('/identity/context', guardian); assert.equal(verified.accessible_patients[0].display_name, '合成儿童');
        const childReport = await api('/patient/comprehensive_report', guardian); assert.equal(childReport.patient_name, '合成儿童');
        record('actual institutional review grants child access with child and guardian names kept separate');
        const childInvite = await api('/care/relationships/invitations', doctor, {
            target_email: guardian.user.email, patient_id: verified.accessible_patients[0].patient_id,
            scope: ['profile', 'assessment'], purpose: 'clinical_sharing'
        }, 'POST', 201);
        assert.equal(childInvite.patient_name, null);
        assert.equal((await api('/care/relationships', doctor)).items.find(row => row.id === childInvite.id).patient_name, null);
        await api(`/doctor/patient/${verified.accessible_patients[0].patient_id}/report`, doctor, undefined, 'GET', 403);
        await profile(dPage, 'researcher');
        await dPage.waitForFunction(id => document.querySelector(`[data-relationship-id="${id}"]`), {}, childInvite.id);
        assert.ok(!(await dPage.$eval(`[data-relationship-id="${childInvite.id}"]`, node => node.textContent)).includes('合成儿童'));
        record('actual pending child invitation and rendered doctor relationship release no unconfirmed child name');
        await rPage.type(`[data-guardian-id="${guardianId}"] [data-authorization-input="review-reference"]`, 'synthetic-suspension');
        await rPage.click(`[data-guardian-id="${guardianId}"] [data-authorization-action="guardian-suspend"]`); await waitStatus(rPage, '监护关系状态已更新');
        await api('/patient/dashboard_status', guardian, undefined, 'GET', 403);
        await gPage.bringToFront(); await gPage.click('[data-authorization-action="refresh"]');
        await gPage.waitForFunction(() => document.querySelector('[data-authorization-panel]').textContent.includes('已暂停'));
        record('actual institutional suspension removes guardian access and updates existing account view');
        await rPage.bringToFront(); await rPage.type(`[data-guardian-id="${guardianId}"] [data-authorization-input="review-reference"]`, 'synthetic-restoration');
        await rPage.click(`[data-guardian-id="${guardianId}"] [data-authorization-action="guardian-restore"]`); await waitStatus(rPage, '监护关系状态已更新');
        await api('/patient/dashboard_status', guardian);
        await rPage.evaluate(() => window.scrollTo(0, 0));
        await rPage.screenshot({ path: path.join(evidence, 'w02-browser-institution-guardian.png'), fullPage: true });
        record('actual verified recovery restores guardian access through a new audited revision');
        const successor = await register('w02-successor@example.org', '合成新监护人', 'patient', { account_only: true, patient_profile: null });
        const sPage = await openActor(successor); await profile(sPage, 'patient');
        const restoredGuardian = (await api('/identity/context', guardian)).guardian_relationships.find(row => row.id === guardianId);
        await sPage.click('[data-authorization-panel] details summary');
        for (const [field, value] of [['relationship', guardianId], ['revision', restoredGuardian.revision], ['age', 36], ['proof', 'synthetic-new-guardian-proof']]) {
            await sPage.type(`[data-authorization-input="identity-${field}"]`, String(value));
        }
        await sPage.click('[data-authorization-action="confirm-transfer"]'); await waitStatus(sPage, '本人确认已记录');
        await api('/patient/dashboard_status', successor, undefined, 'GET', 403);
        record('actual new guardian authenticated confirmation alone grants no child access');
        await rPage.bringToFront(); await rPage.click('[data-authorization-action="refresh"]');
        await rPage.waitForSelector(`[data-guardian-id="${guardianId}"] [data-authorization-action="guardian-transfer"]`);
        await rPage.type(`[data-guardian-id="${guardianId}"] [data-authorization-input="review-reference"]`, 'synthetic-handoff-review');
        await rPage.type(`[data-guardian-id="${guardianId}"] input[aria-label="与新监护人本人确认一致的证明引用"]`, 'synthetic-new-guardian-proof');
        await rPage.click(`[data-guardian-id="${guardianId}"] [data-authorization-action="guardian-transfer"]`);
        await waitStatus(rPage, '身份转换已记录');
        await api('/patient/dashboard_status', guardian, undefined, 'GET', 403);
        await api('/patient/dashboard_status', successor);
        const successorContext = await api('/identity/context', successor);
        assert.equal(successorContext.accessible_patients[0].patient_id, verified.accessible_patients[0].patient_id);
        assert.equal(successorContext.accessible_patients[0].access_kind, 'guardian');
        record('actual institutional handoff grants the accepted new guardian and denies the original guardian');
        const newRelationship = successorContext.guardian_relationships.find(row => row.status === 'verified');
        const adult = await register('w02-adult-identity@example.org', '合成成年本人', 'patient', { account_only: true, patient_profile: null });
        const aPage = await openActor(adult); await profile(aPage, 'patient');
        await aPage.click('[data-authorization-panel] details summary');
        for (const [field, value] of [['relationship', newRelationship.id], ['revision', newRelationship.revision], ['age', 19], ['proof', 'synthetic-adult-control-proof']]) {
            await aPage.type(`[data-authorization-input="identity-${field}"]`, String(value));
        }
        await aPage.click('[data-authorization-action="confirm-adult-conversion"]'); await waitStatus(aPage, '本人确认已记录');
        await api('/patient/dashboard_status', adult, undefined, 'GET', 403);
        await rPage.bringToFront(); await rPage.click('[data-authorization-action="refresh"]');
        await rPage.waitForSelector(`[data-guardian-id="${newRelationship.id}"] [data-authorization-action="guardian-adult-conversion"]`);
        await rPage.type(`[data-guardian-id="${newRelationship.id}"] [data-authorization-input="review-reference"]`, 'synthetic-adult-institution-review');
        await rPage.type(`[data-guardian-id="${newRelationship.id}"] input[aria-label="与成年本人确认一致的年龄"]`, '19');
        await rPage.click(`[data-guardian-id="${newRelationship.id}"] [data-authorization-action="guardian-adult-conversion"]`);
        await waitStatus(rPage, '身份转换已记录');
        await api('/patient/dashboard_status', successor, undefined, 'GET', 403);
        const adultContext = await api('/identity/context', adult);
        assert.equal(adultContext.accessible_patients[0].patient_id, verified.accessible_patients[0].patient_id);
        assert.equal(adultContext.accessible_patients[0].access_kind, 'self');
        assert.equal((await api('/auth/me', adult)).full_name, '合成成年本人');
        const newConsents = (await api(`/patient/consents?patient_id=${verified.accessible_patients[0].patient_id}`, adult)).items;
        assert.ok(!newConsents.some(row => row.effective_access && ['clinical_sharing', 'external_ai', 'research'].includes(row.purpose)));
        await api('/patient/submit_scale', adult, { scale_type: 'ASRS', respondent_type: 'self', answers: Array(18).fill(0) }, 'POST', 403);
        await aPage.bringToFront(); await aPage.click('[data-authorization-action="refresh"]');
        await aPage.waitForSelector('[data-authorization-action="grant-basic"]');
        await aPage.click('[data-authorization-action="grant-basic"]'); await waitStatus(aPage, '基本使用同意已确认');
        await api('/patient/submit_scale', adult, { scale_type: 'ASRS', respondent_type: 'self', answers: Array(18).fill(0) }, 'POST', 201);
        record('actual adult conversion keeps the same patient, uses a distinct self account and inherits no prior optional consent');
        // Actual mini-program component and request adapter against the same real
        // temporary API. wx transport/modal are controlled; this is not a claim of
        // WeChat device rendering or genuine institutional credential validation.
        let componentDefinition;
        const mobileStorage = { api_base_url: `${origin}/api/v1`, access_token: owner.access_token, current_user: owner.user };
        global.wx = {
            getStorageSync: key => mobileStorage[key],
            showModal: options => options.success({ confirm: true }),
            request: options => {
                fetch(options.url, { method: options.method, headers: options.header,
                    ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }) })
                    .then(async response => options.success({ statusCode: response.status, data: await response.json() }))
                    .catch(error => options.fail({ errMsg: String(error) }));
            }
        };
        global.Component = definition => { componentDefinition = definition; };
        require(path.join(root, 'miniprogram/components/authorization-panel/index.js'));
        const mobilePanel = { ...componentDefinition.methods, properties: { role: 'patient' }, data: structuredClone(componentDefinition.data),
            setData(values) { Object.assign(this.data, values); } };
        assert.equal(await mobilePanel.reloadAuthorization(), true);
        assert.equal(mobilePanel.data.patientId, patientId);
        assert.ok(mobilePanel.data.relationships.some(row => row.status === 'revoked'));
        assert.equal(await mobilePanel.grantExternalAi(), true);
        let mobileConsent = mobilePanel.data.consents.find(row => row.purpose === 'external_ai' && row.canWithdraw);
        assert.ok(mobileConsent);
        assert.equal(await mobilePanel.withdrawConsent({ currentTarget: { dataset: { id: mobileConsent.id } } }), true);
        mobileConsent = mobilePanel.data.consents.find(row => row.id === mobileConsent.id);
        assert.equal(mobileConsent.canWithdraw, false);
        assert.equal(mobileConsent.effective_access, false);
        record('actual mini-program component and request code connect consent actions to the real temporary API; controlled wx transport only');
        const scopedOwner = await register('w02-assessment-only@example.org', '合成评估权限本人');
        const scopedId = scopedOwner.user.patient_profile.id;
        await api('/patient/submit_scale', scopedOwner, { scale_type: 'ASRS', respondent_type: 'self', answers: Array(18).fill(4) }, 'POST', 201);
        const scopedInvite = await api('/care/relationships/invitations', doctor, {
            target_email: scopedOwner.user.email, scope: ['assessment'], purpose: 'clinical_sharing'
        }, 'POST', 201);
        await api(`/care/relationships/${scopedInvite.id}/accept`, scopedOwner, { expected_revision: scopedInvite.revision });
        const scopedList = (await api('/doctor/my_patients', doctor)).items.find(row => row.patient_id === scopedId);
        assert.deepEqual(scopedList.allowed_scope, ['assessment']);
        assert.equal(scopedList.patient_name, null); assert.equal(scopedList.latest_scale_total_score, 72);
        await dPage.bringToFront();
        await dPage.goto(`${origin}/doctor-web/doctor_patients.html?focus_patient_id=${scopedId}`, { waitUntil: 'domcontentloaded' });
        await dPage.waitForSelector(`#patient-row-${scopedId} .view-report-btn`);
        assert.ok((await dPage.$eval(`#patient-row-${scopedId}`, node => node.textContent)).includes('影像未共享'));
        await Promise.all([dPage.waitForNavigation({ waitUntil: 'domcontentloaded' }), dPage.click(`#patient-row-${scopedId} .view-report-btn`)]);
        await dPage.waitForFunction(id => document.querySelector('#patientTitle')?.textContent.includes(`共享档案 #${id}`), {}, scopedId);
        assert.ok((await dPage.$eval('#reportContent', node => node.textContent)).includes('72'));
        assert.equal(await dPage.$eval('#openVisualizationBtn', node => node.disabled), true);
        await dPage.screenshot({ path: path.join(evidence, 'w02-browser-assessment-only.png'), fullPage: true });
        const actualAssessment = await api(`/doctor/patient/${scopedId}/report`, doctor);
        const normalizer = require(path.join(root, 'miniprogram/utils/doctor-data.js'));
        const mobileScopedReport = normalizer.normalizePatientReport(actualAssessment);
        assert.equal(mobileScopedReport.scale.totalScore, 72); assert.equal(mobileScopedReport.imagingStatusText, '影像未共享');
        record('actual assessment-only list opens real scoped report in doctor web and mobile normalizer without borrowing profile or imaging');

        const careOwner = await register('w02-care-only@example.org', '合成随访权限本人');
        const careId = careOwner.user.patient_profile.id;
        const careInvite = await api('/care/relationships/invitations', doctor, { target_email: careOwner.user.email,
            scope: ['care'], purpose: 'clinical_sharing' }, 'POST', 201);
        await api(`/care/relationships/${careInvite.id}/accept`, careOwner, { expected_revision: careInvite.revision });
        await api(`/care/doctor/patient/${careId}/messages`, doctor, { content: '仅care的真实合成随访消息', client_message_id: 'w02-care-only' }, 'POST', 201);
        await api(`/doctor/patient/${careId}/report`, doctor, undefined, 'GET', 403);
        await dPage.goto(`${origin}/doctor-web/doctor_patients.html?focus_patient_id=${careId}`, { waitUntil: 'domcontentloaded' });
        await dPage.waitForSelector(`#patient-row-${careId} .view-care-btn`);
        assert.equal(await dPage.$(`#patient-row-${careId} .view-report-btn`), null);
        await dPage.click(`#patient-row-${careId} .view-care-btn`);
        await dPage.waitForFunction(() => document.querySelector('#doctorCareDrawer')?.classList.contains('open') && document.querySelector('#doctorCareMessageThread').textContent.includes('仅care的真实合成随访消息'));
        assert.ok((await dPage.$eval('#doctorCareTitle', node => node.textContent)).includes(`共享档案 #${careId}`));
        await dPage.screenshot({ path: path.join(evidence, 'w02-browser-care-only.png'), fullPage: true });
        record('actual care-only workbench entry shows real shared message without fabricating report or profile name');
        let mobilePageDefinition;
        global.Page = definition => { mobilePageDefinition = definition; };
        mobileStorage.access_token = doctor.access_token; mobileStorage.current_user = doctor.user;
        require(path.join(root, 'miniprogram/pages/doctor-patient/index.js'));
        const mobileCarePage = { ...mobilePageDefinition, data: { ...structuredClone(mobilePageDefinition.data), patientId: careId },
            setData(values) { Object.assign(this.data, values); } };
        await mobileCarePage.loadPatientData();
        assert.equal(mobileCarePage.data.report, null);
        assert.equal(mobileCarePage.data.detailsAvailable, true);
        assert.ok(mobileCarePage.data.messages.some(item => item.content === '仅care的真实合成随访消息'));
        assert.equal(mobileCarePage.data.patientName, `共享档案 #${careId}`);
        record('actual mobile doctor patient controller and request adapter read care-only real API; controlled wx transport without device rendering');
        fs.writeFileSync(path.join(evidence, 'w02-browser-workflow.json'), JSON.stringify({ scope: 'Actual Chrome/pages/API; temporary synthetic business DB plus separate authorization ledger; fixture institution provisioning only', passed: results.length, results, pageErrors: errors, browser: await browser.version() }, null, 2));
    } catch (error) {
        fs.writeFileSync(path.join(evidence, 'w02-browser-workflow-failed.json'), JSON.stringify({ results, error: String(error), pageErrors: errors, serverLog: log }, null, 2));
        throw error;
    } finally {
        fs.writeFileSync(path.join(evidence, 'w02-browser-server.txt'), log);
        for (const context of contexts) await context.close().catch(() => {});
        if (browser) await browser.close();
        server.kill();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
