(() => {
    'use strict';
    const guard = window.SessionGuard, api = window.API.Assessment;
    const snapshot = guard.assertCurrentSession();
    const role = snapshot.role;
    const statusLabels = { draft: '待发布', active: '进行中', evidence_ready: '材料已齐', closed_self: '自助已完成', under_review: '等待医生审核',
        reviewed: '医生已复核', suspended: '已暂停', cancelled: '已取消', not_started: '未开始', in_progress: '已开始', submitted: '已提交',
        pending_validation: '待验证', valid: '有效', limited: '有局限', invalid: '无效', not_required: '无需医生验收', pending_review: '待医生验收',
        accepted: '医生已验收', needs_repeat: '需要重测', rejected: '已拒绝' };
    const backgrounds = [{ key: 'diagnosis_history', label: '既往评估情况' }, { key: 'medication', label: '相关用药情况' },
        { key: 'other_conditions', label: '其他健康情况' }, { key: 'sleep', label: '睡眠情况' }, { key: 'school_work', label: '学习或工作情况' }];
    const root = document.getElementById('assessmentShell'), message = document.getElementById('assessmentMessage');
    const templateSelect = document.getElementById('assessmentTemplate'), createButton = document.getElementById('createAssessmentButton');
    const details = document.getElementById('assessmentDetails'), list = document.getElementById('assessmentList');
    const query = new URLSearchParams(location.search), adoptionId = Number(query.get('ai_decision_id'));
    const state = { patientId: null, patientType: '', templates: [], sessions: [], session: null, busy: false, version: 0, active: true, adoption: null, adoptionSaved: false };
    const fields = {};
    const current = version => state.active && state.version === version && guard.isCurrentSession(snapshot);
    const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = String(text); if (className) element.className = className; return element; };
    const status = value => statusLabels[value] || '状态待确认';
    const positive = value => Number.isInteger(Number(value)) && Number(value) > 0;
    const canCreate = template => template && ['test_only', 'reference_use'].includes(template.admission_status) &&
        template[role === 'researcher' ? 'can_create_doctor_assigned' : 'can_create_self'] === true;
    function button(text, action, disabled = false) {
        const element = node('button', text); element.type = 'button'; element.disabled = disabled;
        element.addEventListener('click', () => { if (!state.busy && guard.isCurrentSession(snapshot)) action(); }); return element;
    }
    function clear() {
        state.active = false; state.version++; state.busy = false; state.session = null; state.templates = []; state.sessions = []; state.adoption = null;
        details.replaceChildren(); list.replaceChildren(); templateSelect.replaceChildren();
        Object.values(fields).forEach(field => { field.status.value = 'skipped'; field.value.value = ''; field.value.hidden = true; field.confirm.checked = false; });
        document.getElementById('assessmentSubject').textContent = '';
        document.getElementById('assessmentAssisted').checked = false;
        message.textContent = '';
        createButton.disabled = true;
    }
    guard.onInvalidated(clear);
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', event => {
        if (event.persisted && guard.isCurrentSession(snapshot)) { state.active = true; reload(); }
    });
    for (const field of backgrounds) {
        const wrapper = node('div', undefined, 'assessment-background');
        const select = node('select'); select.setAttribute('aria-label', `${field.label}状态`);
        for (const [value, label] of [['skipped', '跳过'], ['unknown', '不知道'], ['provided', '提供']]) {
            const option = node('option', label); option.value = value; select.append(option);
        }
        const input = node('textarea'); input.maxLength = 1000; input.hidden = true; input.setAttribute('aria-label', field.label);
        select.addEventListener('change', () => { input.hidden = select.value !== 'provided'; if (input.hidden) input.value = ''; });
        const confirm = node('input'); confirm.type = 'checkbox'; const confirmation = node('label', `我已核对${field.label}的内容和状态`); confirmation.append(confirm); confirmation.hidden = true;
        wrapper.append(node('label', `${field.label}（选填）`), select, input, confirmation);
        document.getElementById('assessmentBackground').append(wrapper); fields[field.key] = { status: select, value: input, confirm, confirmation, wrapper };
    }
    function updateAvailability() {
        const template = state.templates.find(item => item.id === templateSelect.value);
        createButton.disabled = state.busy || !canCreate(template);
        for (const field of Object.values(fields)) {
            field.status.disabled = state.busy || Boolean(state.adoption); field.value.readOnly = Boolean(state.adoption); field.confirm.disabled = state.busy;
            field.status.querySelector('option[value="provided"]').disabled = !template || template.background_processing_allowed !== true;
            if ((!template || template.background_processing_allowed !== true) && field.status.value === 'provided') {
                field.status.value = 'skipped'; field.value.value = ''; field.value.hidden = true;
            }
        }
    }
    templateSelect.addEventListener('change', updateAvailability);
    function renderSession(session) {
        if (!session || !positive(session.id) || session.patient_id !== state.patientId) throw new Error('评估响应与当前档案不一致，请刷新。');
        state.session = session; details.replaceChildren();
        renderList([session, ...state.sessions.filter(item => item.id !== session.id)]);
        details.append(node('h2', `第 ${session.id} 轮 · ${status(session.status)}`),
            node('p', session.source === 'self' ? '自助项目无需医生验收。' : '医生任务需要真实提交及医生验收。', 'assessment-note'));
        if (session.usage_notice || session.demonstration_only) details.append(node('p', session.usage_notice || '参考评估用于了解注意状态，不替代医生诊断。', 'assessment-note'));
        const reports = node('a', '查看本轮已发布报告');
        reports.href = `${role === 'researcher' ? 'doctor_reports' : 'patient_reports'}.html?patient_id=${state.patientId}&assessment_id=${session.id}`;
        details.append(reports);
        const actions = role === 'researcher' ? [['核对材料、补问和正式发布','doctor_review.html'],['真实日期计划','doctor_plan.html']] : [['医生具体补问与本人答复','patient_questions.html'],['已发布计划与收到确认','patient_plan.html']];
        for (const [title,file] of actions) { const a=node('a',title);a.href=`${file}?patient_id=${state.patientId}&assessment_id=${session.id}`;a.style.margin='12px';details.append(a); }
        const image=node('a','已生成影像分析报告');image.href=`${role==='researcher'?'doctor':'patient'}_imaging_reports.html?patient_id=${state.patientId}`;details.append(image);
        const followup=node('a','真实日期随访与长期总结');followup.href=`${role==='researcher'?'doctor':'patient'}_followup.html?patient_id=${state.patientId}`;details.append(followup);
        if (session.background_visibility === 'withheld') details.append(node('p', '背景资料未共享。', 'assessment-note'));
        for (const [key, field] of Object.entries(session.background || {})) {
            const label = backgrounds.find(item => item.key === key)?.label || key;
            const value = field.status === 'skipped' ? '已跳过，情况未知' : field.status === 'unknown' ? '不知道' : typeof field.value === 'string' ? field.value : JSON.stringify(field.value);
            details.append(node('p', `${label}：${value}`));
        }
        if (role === 'researcher' && (session.allowed_actions || []).includes('publish')) details.append(button('确认并发布评估', () => operate(() => api.publish(session.id, session.version), '评估已发布。')));
        for (const item of session.items || []) {
            const card = node('section', undefined, 'assessment-item');
            card.append(node('h3', item.title), node('p', `执行：${status(item.execution_status)} · 质量：${status(item.quality_status)} · 验收：${status(item.acceptance_status)}`, 'assessment-note'));
            if (item.repeat_request) card.append(node('p', `医生要求重测：${item.repeat_request.reason}（报告第 ${item.repeat_request.report_version} 版）。原结果保留。`, 'assessment-note'));
            if (item.recall_window === 'P6M') card.append(node('p', '根据近六个月实际情况填写，不作为短周期改善指标。', 'assessment-note'));
            for (const attempt of item.attempts || []) card.append(node('p', `尝试 ${attempt.id} · ${status(attempt.execution_status)} · ${status(attempt.quality_status)}`, 'assessment-note'));
            if (role === 'patient' && (item.allowed_actions || []).includes('create_attempt')) {
                if(item.kind==='scale'){const a=node('a','在网页完成本轮量表与真实提交');a.href=`patient_formal_scale.html?patient_id=${state.patientId}&assessment_id=${session.id}&item_id=${item.id}`;card.append(a);}
                else if (item.kind === 'cognitive' && item.protocol_id === 'continuous-mobile-v4') {const a=node('a','在网页完成本轮完整认知任务');a.href=`patient_formal_cognitive.html?patient_id=${state.patientId}&assessment_id=${session.id}&item_id=${item.id}`;card.append(a);}
                else card.append(button('创建新尝试', () => createAttempt(item)));
            }
            details.append(card);
        }
        details.append(node('p', '执行、质量与医生验收分别以服务器记录为准；小程序与网页按各自实际设备记录，跨设备可比性另行核验。', 'assessment-note'));
    }
    function renderList(sessions) {
        state.sessions = sessions;
        list.replaceChildren();
        if (!sessions.length) list.append(node('p', '暂无可访问的评估。', 'assessment-note'));
        for (const session of sessions) {
            const item = button(`第 ${session.id} 轮 · ${session.source === 'self' ? '自助' : '医生发布'} · ${status(session.status)}`,
                () => operate(() => api.get(session.id), '已读取本轮资料。'));
            item.dataset.assessmentId = session.id; list.append(item);
        }
    }
    async function operate(action, successMessage) {
        if (state.busy || !guard.isCurrentSession(snapshot)) return false;
        const version = ++state.version; state.busy = true; message.textContent = '正在处理…'; updateAvailability();
        try {
            const assertCurrent = () => { if (!current(version)) throw new Error('会话或页面已变更，请重新操作。'); };
            assertCurrent();
            const result = await action(assertCurrent);
            if (!current(version)) return false;
            renderSession(result); message.textContent = successMessage;
            return true;
        } catch (error) {
            if (!current(version)) return false;
            details.replaceChildren(); state.session = null; message.textContent = error.message || '操作未完成，请重试。';
            return false;
        } finally {
            if (current(version)) { state.busy = false; updateAvailability(); }
        }
    }
    async function reload() {
        if (state.busy || !guard.isCurrentSession(snapshot)) return false;
        const version = ++state.version; state.busy = true; message.textContent = '正在读取评估…'; updateAvailability();
        try {
            if (role !== document.body.dataset.assessmentRole) throw new Error('请使用对应的用户或医生账号打开本页。');
            if (role === 'patient') {
                const context = await window.API.Authorization.getContext();
                if (!current(version)) return false;
                const requested = Number(query.get('patient_id')), patient = positive(requested)
                    ? (context.accessible_patients || []).find(row => row.patient_id === requested) : (context.accessible_patients || [])[0];
                if (!patient) throw new Error('当前没有获准访问的档案，请在账号与隐私中核对身份。');
                state.patientId = patient.patient_id; state.patientType = patient.patient_type;
                document.getElementById('assessmentSubject').textContent = patient.display_name || `档案 #${patient.patient_id}`;
            } else {
                const id = new URLSearchParams(location.search).get('patient_id');
                if (!positive(id)) throw new Error('请从患者工作台选择已共享档案。');
                state.patientId = Number(id); document.getElementById('assessmentSubject').textContent = `共享档案 #${id}`;
            }
            const [templates, sessions] = await Promise.all([api.getTemplates(state.patientId), api.list(state.patientId)]);
            if (!current(version)) return false;
            state.templates = templates.items || []; templateSelect.replaceChildren();
            for (const template of state.templates) {
                const option = node('option', `${template.title} · ${template.version} · ${template.admission_status === 'blocked' ? '尚未开放' : '参考评估'}`);
                option.value = template.id; option.disabled = !canCreate(template); templateSelect.append(option);
            }
            const selected = state.templates.find(canCreate);
            if (selected) templateSelect.value = selected.id;
            document.getElementById('assessmentAdmission').textContent = selected ? (selected.usage_notice || '参考评估用于了解注意状态，不替代医生诊断。') : state.templates.some(item => ['test_only', 'reference_use'].includes(item.admission_status))
                ? '当前使用或共享授权不满足新建要求，可以查看已有评估。' : '当前模板尚未完成准入审核，暂不能新建评估。';
            renderList(sessions.items || []); message.textContent = '已读取当前可访问的评估。';
            state.adoption = null;
            if (positive(adoptionId) && !state.adoptionSaved) {
                const adopted = await window.API.Agent.adoption(adoptionId); if (!current(version)) return false;
                const content = adopted.content?.fields;
                if (adopted.id !== adoptionId || adopted.actor_user_id !== snapshot.accountId || adopted.patient_id !== state.patientId || adopted.target_type !== 'assessment_background' || !content || !Object.keys(content).length || Object.keys(content).some(key => !fields[key])) throw new Error('背景建议与当前账号和档案不一致。');
                if (Object.values(content).some(field => field.status === 'provided') && selected?.background_processing_allowed !== true) throw new Error('当前未获背景资料处理权限，请重新核对。');
                state.adoption = adopted;
                for (const [key, field] of Object.entries(fields)) {
                    const value = content[key]; field.wrapper.hidden = !value; field.confirmation.hidden = !value; field.confirm.checked = false;
                    field.status.value = value ? value.status : 'skipped'; field.value.value = value?.value || ''; field.value.hidden = !value || value.status !== 'provided';
                }
                message.textContent = '已带入本人核对的背景。请逐项再次核对并勾选后保存新的一轮；修改内容请回星仔重新核对。';
            }
            return true;
        } catch (error) {
            if (!current(version)) return false;
            state.templates = []; state.sessions = []; state.session = null; state.adoption = null; templateSelect.replaceChildren(); list.replaceChildren(); details.replaceChildren();
            Object.values(fields).forEach(field => { field.value.value = ''; field.confirm.checked = false; });
            message.textContent = error.message || '评估读取失败，请重试。'; return false;
        } finally { if (current(version)) { state.busy = false; updateAvailability(); } }
    }
    createButton.addEventListener('click', () => {
        const template = state.templates.find(item => item.id === templateSelect.value && canCreate(item));
        if (!template || state.busy) return;
        const background = {}, source = role === 'researcher' ? 'patient_report' : state.patientType === 'child' ? 'guardian_report' : 'self_report';
        for (const [key, field] of Object.entries(fields)) {
            if (state.adoption && !Object.prototype.hasOwnProperty.call(state.adoption.content.fields, key)) continue;
            if (state.adoption && !field.confirm.checked) { message.textContent = '请逐项勾选确认带入的背景内容和状态。'; return; }
            if (field.status.value === 'provided' && template.background_processing_allowed !== true) { message.textContent = '当前未授权处理背景资料，请选择不知道或跳过。'; return; }
            if (field.status.value === 'provided' && !field.value.value.trim()) { message.textContent = '已选择提供的背景需要填写内容；也可以不知道或跳过。'; return; }
            background[key] = { status: field.status.value, value: field.status.value === 'provided' ? state.adoption ? field.value.value : field.value.value.trim() : null, source, confirmed: true };
        }
        if (state.adoption && !window.confirm('确认把逐项核对的背景保存到新建的这一轮评估？不会改写旧评估或生成测评结果。')) return;
        if (!guard.isCurrentSession(snapshot) || !state.active) return;
        const adopted = state.adoption;
        operate(() => (role === 'patient' ? api.createSelf : api.createDoctor)({ patient_id: state.patientId, template_id: template.id,
            template_version: template.version, previous_assessment_id: null, background,
            ...(adopted ? { source_ai_decision_id: adopted.id, client_assessment_id: adopted.target_client_id } : {}) }).then(value => {
                if (adopted && state.active && guard.isCurrentSession(snapshot)) { state.adoptionSaved = true; state.adoption = null;
                    Object.values(fields).forEach(field => { field.wrapper.hidden = false; field.confirmation.hidden = true; field.confirm.checked = false; field.status.value = 'skipped'; field.value.value = ''; field.value.hidden = true; });
                } return value;
            }), '本轮评估已保存。');
    });
    async function createAttempt(item) {
        if (!window.confirm('确认认知项目由被评估者执行，量表由指定观察者根据实际情况填写。新尝试不会覆盖历史。')) return;
        const assessmentId = state.session.id;
        const assisted = document.getElementById('assessmentAssisted').checked;
        return operate(async assertCurrent => {
            await api.createAttempt(item.id, { expected_item_version: item.version, protocol_id: item.protocol_id,
                ...(item.repeat_request ? { repeat_report_id: item.repeat_request.report_id } : {}),
                protocol_schema_version: item.protocol_schema_version, config_digest: item.config_digest,
                performer_patient_id: item.kind === 'scale' ? null : state.patientId, respondent_kind: item.respondent_kind, confirmed: true,
                device: { platform: 'web', device_type: 'browser', viewport_width: innerWidth, viewport_height: innerHeight },
                input: { method: 'mouse' }, timing: { clock_source: 'Date.now', unit: 'ms', calibrated: false },
                practice: { completed: false, attempts: 0, exposure_count: 0 }, assistance: { provided: assisted, kind: assisted ? 'declared_by_user' : 'none' }, recall_window: item.recall_window });
            assertCurrent();
            return api.get(assessmentId);
        }, '新尝试已开始，本轮记录已保留。');
    }
    document.getElementById('refreshAssessmentsButton').addEventListener('click', reload);
    if (root) reload();
})();
