(() => {
    'use strict';
    const { makePage, node, input, button, link, positive } = window.ClinicalBusiness;
    const page = makePage('artifact', ['patient', 'researcher']); if (!page) return;
    const query = new URLSearchParams(location.search), aid = Number(query.get('artifact_id')), pid = page.patientId;
    if (!positive(aid)) { page.say('请从实际助手建议进入。'); return; }
    const names = { adopt: '本人采纳', edit: '本人编辑', reject: '本人拒绝' };
    const labels = { diagnosis_history: '既往评估情况', medication: '相关用药情况', other_conditions: '其他健康情况', sleep: '睡眠情况', school_work: '学习或工作情况' };
    const targetFiles = { review_draft: 'doctor_review.html', review_question: 'doctor_review.html', plan_publication: 'doctor_plan.html', shared_message: 'doctor_message_compose.html',
        assessment_background: '../patient-web/patient_assessments.html', cycle_review: page.session.role === 'researcher' ? 'doctor_cycle_review.html' : '../patient-web/patient_cycle_review.html' };
    const describe = content => content?.fields ? Object.entries(content.fields).map(([key, field]) => labels[key] + '：' + (field.status === 'provided' ? field.value : field.status === 'unknown' ? '不知道' : '跳过，保持未知')).join('\n')
        : content ? content.question || content.instructions || content.text || '' : '';
    page.reload = async () => {
        const ticket = page.next(), view = page.area('clinicalInputs'), history = page.area('clinicalHistory'); view.replaceChildren(); history.replaceChildren();
        await page.pendingView(); if (!page.current(ticket)) return;
        const versions = await page.request('/agent/artifacts/' + aid + '/decisions'); if (!page.current(ticket)) return;
        if (versions.patient_id !== pid || versions.actor_user_id !== page.session.accountId || versions.artifact_id !== aid || !Array.isArray(versions.items) ||
            versions.items.some(row => row.patient_id !== pid || row.actor_user_id !== page.session.accountId || row.artifact_id !== aid)) throw Error('私有建议核对历史归属不一致。');
        for (const row of versions.items) { const card = node('article'); card.append(node('h2', names[row.decision] + ' · 第 ' + row.version + ' 版'), node('p', row.reason), node('p', describe(row.content))); history.append(card); }
        const latest = versions.items[0];
        if (latest?.target_type && targetFiles[latest.target_type]) {
            try {
                const use = await page.request('/agent/artifact-decisions/' + latest.id + '/adoption-context'); if (!page.current(ticket)) return;
                if (use.id !== latest.id || use.patient_id !== pid || use.actor_user_id !== page.session.accountId || !targetFiles[use.target_type]) throw Error('业务来源不一致。');
                const args = { patient_id: pid, ai_decision_id: use.id };
                if (use.target_type === 'cycle_review') { if (!positive(use.cycle_id)) throw Error('周期摘要尚未绑定具体周期。'); args.cycle_id = use.cycle_id; }
                else if (use.target_type !== 'assessment_background') { if (!positive(use.assessment_id)) throw Error('专业建议尚未绑定具体评估。'); args.assessment_id = use.assessment_id; }
                history.append(link('进入实际业务表单后再次明确确认', targetFiles[use.target_type], args));
            } catch (error) { history.append(node('p', error.message)); }
        }
        if (page.pending) return;
        const ctx = await page.request('/agent/artifacts/' + aid + '/decision-context'); if (!page.current(ticket)) return;
        if (ctx.artifact_id !== aid || ctx.patient_id !== pid || ctx.actor_user_id !== page.session.accountId) throw Error('建议与原实际账号或档案不一致。');
        const content = ctx.default_content || {}, form = node('form'), title = input('本人核对的计划标题', false, 120),
            body = input('本人核对的建议正文', true, ['assessment_summary', 'cycle_summary'].includes(ctx.kind) ? 8000 : 4000), reason = input('核对原因', true, 2000);
        const isProfile = ctx.kind === 'profile_fields', profile = {};
        title.field.value = content.title || ''; title.wrapper.hidden = ctx.kind !== 'plan_draft';
        body.field.value = content.question || content.instructions || content.text || ''; body.wrapper.hidden = isProfile; reason.field.required = true;
        form.append(node('h2', '本人采纳、编辑或拒绝'), node('p', '保存核对决定不会自动保存背景、修改日期记录、发送消息或发布专业意见。'), title.wrapper, body.wrapper);
        if (isProfile) for (const [key, value] of Object.entries(content.fields || {})) {
            const section = node('section'), status = node('select'); status.setAttribute('aria-label', (labels[key] || key) + '状态');
            for (const [code, label] of [['skipped', '跳过'], ['unknown', '不知道'], ['provided', '提供']]) { const option = node('option', label); option.value = code; status.append(option); }
            status.value = value.status;
            const text = input(labels[key] || key, true, 1000), confirmed = input('我已核对' + (labels[key] || key) + '的内容和状态', false, 20, 'checkbox');
            text.field.value = value.value || ''; text.wrapper.hidden = value.status !== 'provided'; confirmed.field.required = true;
            status.addEventListener('change', () => { text.wrapper.hidden = status.value !== 'provided'; if (text.wrapper.hidden) text.field.value = ''; confirmed.field.checked = false; });
            text.field.addEventListener('input', () => { confirmed.field.checked = false; });
            section.append(node('h3', labels[key] || key), status, text.wrapper, confirmed.wrapper); form.append(section); profile[key] = { status, text, confirmed };
        }
        form.append(reason.wrapper);
        const actualContent = () => isProfile ? { fields: Object.fromEntries(Object.entries(profile).map(([key, field]) => [key, { status: field.status.value, value: field.status.value === 'provided' ? field.text.field.value : null }])) }
            : ctx.kind === 'plan_draft' ? { ...content, title: title.field.value, instructions: body.field.value }
                : ctx.kind === 'review_questions' ? { ...content, question: body.field.value } : { text: body.field.value };
        const apply = decision => {
            if (!page.current(ticket)) return;
            if (decision !== 'reject' && isProfile && Object.values(profile).some(field => !field.confirmed.field.checked || field.status.value === 'provided' && !field.text.field.value.trim())) { page.say('请逐项确认背景内容与状态；选择提供的项目需要实际文字。'); return; }
            page.submit({ label: '建议人工核对决定', idField: 'client_decision_id', tokenField: 'decision_context', contextField: 'decision_context_digest', contextDigest: ctx.decision_context_digest,
                route: '/agent/artifact-decisions', queryRoute: '/agent/artifact-decisions/submissions/', payload: { client_decision_id: page.newId('draft'), patient_id: pid, artifact_id: aid, expected_previous_version: ctx.expected_previous_version,
                    decision_context: ctx.decision_context, decision, content: decision === 'reject' ? null : actualContent(), reason: reason.field.value, confirmed: true,
                    ...(isProfile && decision !== 'reject' ? { confirmed_fields: Object.keys(profile) } : {}) },
                confirm: decision === 'reject' ? '确认记录本人拒绝此建议？' : '确认记录本人逐项核对后的内容？实际业务仍需另行确认。' });
        };
        if (ctx.allowed_decisions.includes('adopt')) {
            const use = node('button', '确认采纳或保存本人编辑'); use.type = 'submit'; form.append(use);
            form.addEventListener('submit', event => { event.preventDefault(); apply(window.ClinicalBusiness.canonical(actualContent()) === window.ClinicalBusiness.canonical(content) ? 'adopt' : 'edit'); });
        }
        form.append(button('明确拒绝本建议', () => { if (!reason.field.value.trim()) { reason.field.reportValidity(); return; } apply('reject'); })); view.append(form); page.say('已读取本账号实际建议及人工决定历史。');
    }; page.run(page.reload);
})();
