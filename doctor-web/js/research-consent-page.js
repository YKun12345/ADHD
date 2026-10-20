/* Specific-project consent for the patient's verified own identity only. */
(() => {
    'use strict';
    const business = window.ClinicalBusiness;
    const page = business.makePage('federated', ['patient']);
    if (!page) return;
    const { node, input, button, positive } = business;
    const query = new URLSearchParams(location.search);
    const projectId = /^[1-9]\d*$/.test(query.get('project_id') || '') ? Number(query.get('project_id')) : 0;
    const labels = { profile: '基础资料', assessment: '评估与报告', tracking: '追踪记录', care: '任务与消息', imaging: '已有影像分析' };
    const statuses = { active: '当前有效', withdrawn: '已撤回', superseded: '被后续授权替代', pending: '待生效', denied: '当前授权校验未通过', expired: '已到期', revoked: '已撤销' };
    function open(patientId, project, ticket) {
        if (!page.current(ticket) || !positive(patientId)) return;
        const args = new URLSearchParams({ patient_id: String(patientId) });
        if (positive(project)) args.set('project_id', String(project));
        location.href = 'patient_research_consent.html?' + args;
    }
    page.reload = async () => {
        const ticket = page.next();
        page.area('clinicalInputs').replaceChildren(); page.area('clinicalHistory').replaceChildren();
        // Originals remain queryable even when the current patient authority is lost.
        await page.pendingView(); if (!page.current(ticket)) return;
        const identity = await page.request('/identity/context'); if (!page.current(ticket)) return;
        if (identity.user_id !== page.session.accountId || !Array.isArray(identity.accessible_patients)) throw new Error('当前账号的身份材料不一致。');
        const patients = identity.accessible_patients.filter(row => positive(row.patient_id) &&
            (row.access_kind === 'self' || row.access_kind === 'guardian' && row.guardian_status === 'verified'));
        const selection = page.area('clinicalInputs'), pickerLabel = node('label', '本人或实际监护档案'), picker = node('select');
        picker.setAttribute('aria-label', '本人或实际监护档案');
        const placeholder = node('option', '请选择具体档案'); placeholder.value = ''; picker.append(placeholder);
        for (const patient of patients) {
            const option = node('option', `${patient.display_name || '档案'} · ${patient.patient_id} · ${patient.access_kind === 'self' ? '本人' : '已核验监护'}`);
            option.value = String(patient.patient_id); option.selected = patient.patient_id === page.patientId; picker.append(option);
        }
        pickerLabel.append(picker); selection.append(pickerLabel);
        const project = input('机构提供的具体研究项目编号', false, 20, 'text'); project.field.inputMode = 'numeric';
        project.field.value = positive(projectId) ? String(projectId) : ''; selection.append(project.wrapper);
        project.field.addEventListener('input', () => {
            if (page.current(ticket)) { page.area('clinicalHistory').replaceChildren(); page.say('项目编号已改变，请先读取该具体项目，重新选择范围。'); }
        });
        selection.append(button('核对所选档案与此项目', () => {
            if (!page.current(ticket)) return;
            const pid = Number(picker.value), text = project.field.value.trim();
            if (!patients.some(row => row.patient_id === pid) || !/^[1-9]\d*$/.test(text) || !positive(Number(text))) { page.say('请选择实际本人或监护档案，并填写机构提供的项目编号。'); return; }
            open(pid, Number(text), ticket);
        }));
        picker.addEventListener('change', () => {
            if (!page.current(ticket)) return;
            const pid = Number(picker.value);
            if (patients.some(row => row.patient_id === pid) && pid !== page.patientId) open(pid, 0, ticket);
        });
        if (!page.patientId) { page.say(patients.length ? '请选择具体档案。此页不会采用其他页面暂存的档案。' : '暂无有效的本人或监护档案。'); return; }
        const patient = patients.find(row => row.patient_id === page.patientId);
        if (!patient) throw new Error('当前账号已无此档案的本人或监护权限。已保留的原件仍可按原编号查询。');
        const old = await page.request('/patient/consents?patient_id=' + page.patientId); if (!page.current(ticket)) return;
        if (!Array.isArray(old.items) || old.items.some(row => row.patient_id !== page.patientId)) throw new Error('原授权资料与当前档案不一致。');
        const previousIds = [...new Set(old.items.filter(row => row.purpose === 'research' && positive(row.project_id)).map(row => row.project_id))];
        if (previousIds.length) {
            selection.append(node('p', '从你原有的研究授权进入具体项目：'));
            for (const id of previousIds) selection.append(button(`查看原授权项目 ${id}`, () => open(page.patientId, id, ticket)));
        }
        if (!positive(projectId)) { page.say('填写机构提供的具体项目编号，或选择原授权项目。'); return; }
        const context = await page.request(`/federated/projects/${projectId}/consent?patient_id=${page.patientId}`); if (!page.current(ticket)) return;
        if (context.patient_id !== page.patientId || context.project?.id !== projectId || !Array.isArray(context.items) ||
            context.items.some(row => row.patient_id !== page.patientId || row.project_id !== projectId || row.purpose !== 'research' || typeof row.effective_access !== 'boolean')) throw new Error('项目授权材料与当前档案或具体项目不一致。');
        const currentProject = context.project, history = page.area('clinicalHistory');
        history.append(node('h2', `${currentProject.name} · 项目 ${projectId}`), node('p', `所选档案：${patient.display_name || '档案'} · ${page.patientId}\n具体用途：${currentProject.purpose}\n项目状态：${currentProject.status} · 审批版本 ${currentProject.revision}\n模式：${currentProject.mode === 'synthetic' ? '合成研究，当前不开放真实患者训练' : currentProject.mode}\n项目到期：${currentProject.expires_at || '未单独指定'}`), node('p', context.notice || '仅授权此具体项目和所选资料范围。'));
        history.append(node('h3', '当前授权记录'));
        if (!context.items.length) history.append(node('p', '此项目暂无你的授权记录。'));
        for (const record of context.items) {
            const card = node('article');
            card.append(node('p', `授权 ${record.id} · 第 ${record.revision} 版 · ${record.effective_access ? '当前有效' : statuses[record.effective_status] || statuses[record.status] || '当前无有效授权'}\n范围：${(record.scope || []).map(key => labels[key] || key).join('、')}\n到期：${record.expires_at || '未单独指定，仍受项目和身份有效期限制'}`));
            if (record.status === 'active') {
                const withdraw = button('明确撤回这份原授权', () => {
                    if (!page.current(ticket)) return;
                    return page.submit({ route: `/federated/projects/${projectId}/consent/withdraw`, queryRoute: '/federated/submissions/', idField: 'client_request_id', ackType: 'federated',
                        label: `撤回档案 ${page.patientId} 在项目 ${projectId} 的授权 ${record.id}`, payload: { client_request_id: page.newId('research'), patient_id: page.patientId, consent_id: record.id, expected_revision: record.revision },
                        confirm: `确认撤回 ${patient.display_name || '档案'}（${page.patientId}）在项目“${currentProject.name}”（${projectId}）的原授权 ${record.id}，版本 ${record.revision}？撤回阻止后续处理，不能抹掉已发布模型的全部影响。`, success: '原撤回操作已确认；正在重新读取当前有效状态。' });
                });
                withdraw.disabled = page.pending; card.append(withdraw);
            }
            history.append(card);
        }
        if (currentProject.status !== 'active') { history.append(node('p', '此项目尚未有效或已经撤销，不能新增授权。原授权可按当前状态撤回。')); return; }
        const form = node('fieldset'), legend = node('legend', '明确选择本次授权的资料范围'); form.append(legend);
        const checks = [];
        for (const [scope, label] of Object.entries(labels)) {
            const wrapper = node('label'), field = node('input'); field.type = 'checkbox'; field.value = scope; field.checked = false;
            wrapper.append(field, document.createTextNode(label)); form.append(wrapper); checks.push(field);
        }
        const expires = input('本次授权到期时间（可留空；含时区的未来时间，例如 2027-01-01T00:00:00+08:00）', false, 64); form.append(expires.wrapper);
        const readLabel = node('label'), read = node('input'); read.type = 'checkbox'; read.checked = false;
        readLabel.append(read, document.createTextNode('我已阅读此具体用途、所选范围、到期及撤回影响')); form.append(readLabel);
        const grant = button('明确授权这个项目和所选范围', () => {
            if (!page.current(ticket) || !read.checked) return;
            const scope = checks.filter(field => field.checked).map(field => field.value), expiry = expires.field.value.trim();
            if (!scope.length) { page.say('请自行选择本次授权的具体范围。'); return; }
            if (expiry && (!/(Z|[+-]\d{2}:\d{2})$/.test(expiry) || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) { page.say('到期时间须为含时区的未来时间，或留空。'); return; }
            return page.submit({ route: `/federated/projects/${projectId}/consent`, queryRoute: '/federated/submissions/', idField: 'client_request_id', ackType: 'federated',
                label: `档案 ${page.patientId} 在具体项目 ${projectId} 的研究授权`, payload: { client_request_id: page.newId('research'), patient_id: page.patientId, project_id: projectId, expected_project_revision: currentProject.revision, purpose: 'research', scope, terms_version: 'W02-1', expires_at: expiry || null },
                confirm: `明确同意档案 ${patient.display_name || ''}（${page.patientId}）参加项目“${currentProject.name}”（${projectId}）？\n项目审批版本：${currentProject.revision}\n具体用途：${currentProject.purpose}\n范围：${scope.map(key => labels[key]).join('、')}\n到期：${expiry || '未单独指定，仍受项目和身份有效期限制'}\n条款：W02-1\n撤回阻止后续处理，不能抹掉已发布模型的全部影响。`, success: '原授权操作已确认；正在重新读取当前有效状态。' });
        });
        const update = () => { grant.disabled = page.pending || !read.checked || !checks.some(field => field.checked); };
        for (const field of checks) field.addEventListener('change', () => { read.checked = false; update(); });
        expires.field.addEventListener('input', () => { read.checked = false; update(); }); read.addEventListener('change', update);
        form.disabled = page.pending; form.append(grant); update(); history.append(form);
        page.say(page.pending ? '有未核对的原操作，请先按原编号查询。' : '显示的是服务器刚读取的当前有效状态；原操作确认不能代替当前授权。');
    };
    page.run(page.reload);
})();
