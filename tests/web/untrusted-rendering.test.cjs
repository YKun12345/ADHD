const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { start, ready, rendered } = require('./rendering-browser-harness.cjs');
let harness;
before(async () => { harness = await start(); });
after(async () => { if (harness) await harness.close(); });
const attack = '<img src=x onerror="window.__xss=1"><svg onload="window.__xss=1"></svg>';
const quotedName = 'scan" onerror="window.__xss=1".png';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS4QAAAAASUVORK5CYII=';
async function plain(page, selector, texts) {
    const result = await rendered(page, selector);
    assert.equal(result.injected, 0, `Untrusted text created active markup in ${selector}: ${result.html}`);
    for (const text of texts) assert.ok(result.text.includes(text), `Literal text missing in ${selector}: ${text}`);
    assert.equal(await page.evaluate(() => window.__xss), 0);
}

for (const [kind, pageFile, script] of [
    ['doctor', 'doctor-web/doctor_report.html', 'doctor-web/js/doctor_report.js'],
    ['patient', 'patient-web/patient_report.html', 'patient-web/js/report.js']
]) {
    test(`${kind} report renders names, metadata and recommendations as literal text`, async () => {
        const page = await harness.page(pageFile, script);
        await page.evaluate(attack => renderScaleSummary({ patient_name: attack, patient_type: attack,
            latest_scale: { scale_type: 'Synthetic', total_score: attack, respondent_type: attack,
                risk_level: attack, recommendations: [attack] } }), attack);
        await plain(page, '#reportMeta', [attack]); await plain(page, '#reportRecommendations', [attack]);
        await page.close();
    });
    test(`${kind} imaging rejects executable screenshot URLs`, async () => {
        const page = await harness.page(pageFile, script);
        for (const value of ['javascript:window.__xss=1', 'data:image/svg+xml,<svg onload="window.__xss=1"/>',
            'data:text/html,<script>window.__xss=1</script>', 'x" onerror="window.__xss=1',
            'data:image/png;base64,AAAA" onerror="window.__xss=1', 'https://attacker.invalid/scan.png']) {
            await page.evaluate(value => renderImagingSummary({ visualization_type: 'nifti', slice_screenshot_data: value,
                surface_screenshot_data: value }), value);
            assert.equal(await page.$$eval('#imagingSlicePreview img, #imagingSurfacePreview img', items => items.length), 0, value);
        }
        assert.equal(await page.evaluate(() => window.__xss), 0); await page.close();
    });
    test(`${kind} imaging keeps valid raster preview and quoted filename safely`, async () => {
        const page = await harness.page(pageFile, script);
        await page.evaluate(({ png, quotedName }) => renderImagingSummary({ visualization_type: 'nifti',
            slice_screenshot_data: png, slice_screenshot_name: quotedName }), { png, quotedName });
        const image = await page.$eval('#imagingSlicePreview img', img => ({ src: img.getAttribute('src'),
            alt: img.alt, onerror: img.getAttribute('onerror') }));
        assert.deepEqual(image, { src: png, alt: quotedName, onerror: null }); await page.close();
    });
}

test('doctor security and cognitive descriptions render literal text', async () => {
    const page = await harness.page('doctor-web/doctor_report.html', 'doctor-web/js/doctor_report.js');
    await page.evaluate(attack => {
        renderSecurityOverview({ security_stage: attack, assigned_dac_name: attack, assigned_mcs_node_code: attack,
            latest_temporal_audit_id: attack, latest_temporal_audit_status: attack, latest_temporal_audit_source_type: attack });
        renderCognitiveSummary({ summary: attack, latest_tests: [{ test_name: attack, status_text: attack, key_metric: attack }] });
    }, attack);
    await plain(page, '#securityStatusGrid', [attack]); await plain(page, '#cognitiveTests', [attack]); await page.close();
});

test('doctor patient list, task fields, care names and messages render literal text', async () => {
    const page = await harness.page('doctor-web/doctor_patients.html', 'doctor-web/js/doctor_patients.js', {
        patients: [{ patient_id: 7001, patient_name: attack, patient_email: attack, latest_scale_type: attack,
            latest_scale_risk_level: attack, next_step_text: attack, completed_tracking_days: attack, current_tracking_day: attack,
            latest_scale_total_score: attack }], security: { security_stage: attack, assigned_dac_name: attack,
                assigned_mcs_node_code: attack, has_cipher_records: true, cipher_record_count: attack },
        tasks: [{ task_title: attack, task_description: attack, task_type: attack, status: attack }],
        messages: [{ content: attack, sender_role: 'patient', created_at: '2026-01-01' }],
        aiLogs: [{ content: attack, role: 'assistant', created_at: '2026-01-01' }]
    });
    await page.evaluate(() => {
        window.__privateAiReads = 0;
        const previous = window.API.Care.getDoctorAiLogs;
        window.API.Care.getDoctorAiLogs = async (...args) => { window.__privateAiReads += 1; return previous(...args); };
    });
    await ready(page); await page.waitForSelector('#taskList-7001 .inline-mini-row');
    await plain(page, '#myPatientList', [attack]); await plain(page, '#doctorCarePatientList', [attack]);
    await page.evaluate(() => document.getElementById('openDoctorCareDrawerBtn').click());
    await page.waitForSelector('#doctorCareMessageThread .doctor-care-bubble');
    await plain(page, '#doctorCareMessageThread', [attack]);
    await plain(page, '#doctorCareAiLogThread', ['私人AI对话默认不向医生共享']);
    assert.equal(await page.evaluate(() => window.__privateAiReads), 0);
    assert.equal((await rendered(page, '#doctorCareAiLogThread')).text.includes(attack), false);
    await page.close();
});

test('patient care tasks and messages use literal text and reject unsafe task navigation', async () => {
    const page = await harness.page('patient-web/patient_report.html', 'patient-web/js/report.js', {
        tasks: [{ task_title: attack, task_description: attack, task_type: attack, target_page: 'javascript:window.__xss=1' }],
        messages: [{ content: attack, sender_role: 'researcher' }]
    });
    await page.evaluate(() => renderPatientCareSection()); await page.waitForSelector('#patientTaskList .care-mini-row');
    await plain(page, '#patientTaskList', [attack]); await plain(page, '#patientMessageList', [attack]);
    assert.equal(await page.$$eval('#patientTaskList a[href^="javascript:"]', nodes => nodes.length), 0); await page.close();
});

test('tracking notes, activities and life fields render as literal text', async () => {
    const page = await harness.page('patient-web/patient_tracking.html', 'patient-web/js/tracking.js');
    await page.evaluate(attack => { state.logs = [{ day_index: 1, mood_tag: '3', activities: attack, note: attack,
        is_medication: true, medication_dosage: attack, sleep_quality: attack, focus_minutes: attack }]; renderApp(); }, attack);
    await plain(page, '#logsFeedList', [attack]); await page.close();
});

test('tracking preserves list-valued activities and accepts legacy comma strings', async () => {
    const page = await harness.page('patient-web/patient_tracking.html', 'patient-web/js/tracking.js');
    await page.evaluate(attack => { state.logs = [{ day_index: 1, activities: ['散步,见朋友', attack] }]; renderApp(); }, attack);
    assert.deepEqual(await page.$$eval('.log-card-activity-pill', nodes => nodes.map(node => node.textContent)), ['散步,见朋友', attack]);
    await page.evaluate(() => { state.logs = [{ day_index: 1, activities: '散步,见朋友' }]; renderApp(); });
    assert.deepEqual(await page.$$eval('.log-card-activity-pill', nodes => nodes.map(node => node.textContent)), ['散步', '见朋友']);
    await page.close();
});

for (const error of [false, true]) {
    test(`prediction ${error ? 'error' : 'summary'} renders literal backend text`, async () => {
        const page = await harness.page('doctor-web/doctor_imaging.html', 'doctor-web/js/main.js', {
            patients: [{ patient_id: 7001, patient_name: 'Synthetic' }],
            modelAdmission: { inference_mode: 'mock', status: 'unverified', real_inference_allowed: false },
            prediction: { probability: 0.5, summary_text: attack, source_type: 'mock', is_demo: true }, predictionError: error ? attack : null
        });
        await page.evaluate(() => localStorage.setItem('smartbrain_selected_patient_id', '7001'));
        await ready(page);
        await page.evaluate(() => {
            const input = document.getElementById('timeseriesFileInput'); const transfer = new DataTransfer();
            transfer.items.add(new File(['1,2'], 'synthetic.csv')); input.files = transfer.files;
            input.dispatchEvent(new Event('change')); document.getElementById('generateReportBtn').click();
        });
        await page.waitForFunction(() => !document.getElementById('generateReportBtn').disabled &&
            document.getElementById('predictionStatusBadge').textContent !== '等待中');
        await plain(page, '#predictionSummary', [attack]); await page.close();
    });
}

test('visualization startup errors and uploaded filenames render literal text', async () => {
    const page = await harness.page('doctor-web/doctor_visualization.html', 'doctor-web/js/doctor_visualization.js');
    await page.evaluate(attack => { setStartupAlert(attack); renderSavePanel({ visualization_type: 'nifti',
        func_file_name: attack, anat_file_name: attack, mask_file_name: attack, slice_screenshot_name: attack }); }, attack);
    await plain(page, '#visualizationStartupAlert', [attack]); await plain(page, '#saveVisualizationFiles', [attack]);
    await page.close();
});

test('visualization screenshot preview rejects executable data and safely sets image attributes', async () => {
    const page = await harness.page('doctor-web/doctor_visualization.html', 'doctor-web/js/doctor_visualization.js');
    await page.evaluate(() => { screenshotState.slice = { name: 'unsafe', dataUrl: 'data:image/svg+xml,<svg onload="window.__xss=1"/>' }; renderScreenshotPreview('slice'); });
    assert.equal(await page.$$eval('#sliceScreenshotPreview img', nodes => nodes.length), 0);
    await page.evaluate(({ png, quotedName }) => { screenshotState.slice = { name: quotedName, dataUrl: png }; renderScreenshotPreview('slice'); }, { png, quotedName });
    assert.deepEqual(await page.$eval('#sliceScreenshotPreview img', img => ({ alt: img.alt, onerror: img.getAttribute('onerror') })),
        { alt: quotedName, onerror: null }); await page.close();
});

test('unified Agent renders private replies, sources and draft fields as text nodes', async () => {
    const page = await harness.page('patient-web/patient_ai.html', null);
    await page.evaluate(attack => {
        localStorage.setItem('smartbrain_token','synthetic-rendering-token');
        localStorage.setItem('smartbrain_user',JSON.stringify({id:9001,role:'patient',patient_profile:{id:7001}}));
        window.API.Agent={profiles:async()=>({accessible_patients:[{patient_id:7001,display_name:attack}]}),
            context:async()=>({actor_user_id:9001,role:'patient',patient_id:7001,assessments:[]}),
            actions:async()=>({actor_user_id:9001,patient_id:7001,items:[]}),
            runs:async()=>({actor_user_id:9001,patient_id:7001,items:[{run_id:1,actor_user_id:9001,patient_id:7001,status:'completed',
                mode:'rules',original_message:attack,artifact:{id:2,run_id:1,actor_user_id:9001,patient_id:7001,status:'draft',
                    source_refs:[attack],body:{reply:attack,questions:[{question:attack}],plan_draft:{instructions:attack},reply_draft:{text:attack}}}}]})};
    },attack);
    const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'../..');
    for(const source of ['patient-web/js/session-guard.js','patient-web/js/agent-original.js','patient-web/js/unified-agent.js'])
        await page.addScriptTag({content:fs.readFileSync(path.join(root,source),'utf8')});
    await page.waitForSelector('#agentHistory .agent-reply');
    await plain(page,'#agentHistory',[attack]);
    assert.equal(await page.$eval('#agentHistory .agent-reply',node=>node.firstChild.nodeType),3);await page.close();
});

test('copilot tracking progress renders malicious count literally in tooltip', async () => {
    const page = await harness.page('patient-web/patient_tracking.html', 'patient-web/js/patient_copilot.js', {
        report: { tracking_summary: { completed_count: attack, total_days: 14 } }
    });
    await ready(page); await plain(page, '#pageCopilotText', [attack]); await page.close();
});
