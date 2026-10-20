(() => {
    'use strict';
    const { makePage, node, input, button, link, positive } = window.ClinicalBusiness;
    const page = makePage('plan', ['researcher', 'patient']); if (!page) return;
    const doctor = page.session.role === 'researcher', { patientId, assessmentId } = page, args = { patient_id: patientId, assessment_id: assessmentId };
    const doctorPrefix = doctor ? '' : '../doctor-web/', userPrefix = doctor ? '' : '../patient-web/';
    document.getElementById('clinicalNav').append(link('本轮评估', userPrefix + (doctor ? 'doctor_assessments.html' : 'patient_assessments.html'), args),
        link('已发布报告', userPrefix + (doctor ? 'doctor_reports.html' : 'patient_reports.html'), args));
    const labels = { pending: '待执行', completed: '已有实际记录', overdue: '日期已过且未记录', superseded_future: '未来安排已由新版本替代', active: '进行中', suspended: '已暂停', ended: '已结束' };
    const plusDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
    async function receive(version) {
        return page.run(async () => {
            const ticket = page.next(), ctx = page.check(await page.request(`/care/plan-versions/${version.id}/acknowledgement-context`)); if (!page.current(ticket)) return;
            if (ctx.actor_user_id !== page.session.accountId || ctx.plan_version_id !== version.id || ctx.plan_payload_digest !== version.payload_digest) throw new Error('收到计划确认与所选原版本不一致。');
            const view = page.area('clinicalInputs'); view.replaceChildren(node('h2', '确认收到原计划版本'), node('p', version.title), node('p', version.instructions));
            view.append(button('明确确认收到这一版', () => {
                const id = page.newId('received'); page.submit({ label: '确认收到计划', idField: 'client_acknowledgement_id', tokenField: 'acknowledgement_context', contextField: 'acknowledgement_context_digest',
                    contextDigest: ctx.acknowledgement_context_digest, route: '/care/plan-acknowledgements', queryRoute: '/care/plan-acknowledgements/submissions/',
                    payload: { client_acknowledgement_id: id, patient_id: patientId, assessment_id: assessmentId, plan_version_id: version.id, acknowledgement_context: ctx.acknowledgement_context, confirmed: true },
                    confirm: '确认当前本人或监护人已收到这一版计划？这只记录收到，不会把每日任务标成完成。', success: '已记录收到原计划版本。' });
            }));
        });
    }
    function renderPlan(plan, parent) {
        page.check(plan); if (!positive(plan.id) || !Array.isArray(plan.versions) || !Array.isArray(plan.tasks) || !Array.isArray(plan.acknowledgements)) throw new Error('计划原版本或实际日期安排不完整。');
        parent.append(node('h2', `计划 ${plan.id} · ${labels[plan.status] || plan.status}`));
        if (plan.suspension_reason) parent.append(node('p', `暂停原因：${plan.suspension_reason}`));
        for (const version of plan.versions) {
            page.check(version); if (version.plan_id !== plan.id || !positive(version.cycle_id)) throw new Error('计划版本和实际周期不一致。');
            const card = node('article'); card.append(node('h3', `${version.title} · 第 ${version.version} 版`), node('p', `实际负责医生账号 ${version.actor_user_id} · ${version.start_date} 至 ${version.end_date}`), node('p', version.instructions));
            const receipts = plan.acknowledgements.filter(row => row.plan_version_id === version.id);
            for (const receipt of receipts) { page.check(receipt); card.append(node('p', `账号 ${receipt.actor_user_id} 已确认收到；不表示已完成。`)); }
            if (!doctor && !page.pending && !receipts.some(row => row.actor_user_id === page.session.accountId)) card.append(button('核对并确认收到这一版', () => receive(version)));
            card.append(link(doctor ? '阶段复核、调整与下一轮' : '实际日期记录与阶段决定', doctor ? 'doctor_cycle_review.html' : 'patient_cycle_review.html', { patient_id: patientId, cycle_id: version.cycle_id }));
            parent.append(card);
        }
        const days = node('details'); days.append(node('summary', '查看全部真实日期任务与执行记录'));
        for (const task of plan.tasks) { if (task.patient_id !== patientId) throw new Error('每日任务不属于当前档案。'); days.append(node('p', `${task.record_date} · ${labels[task.status] || task.status}${task.daily_record_id ? ' · 原记录 ' + task.daily_record_id : ''}`)); }
        parent.append(days);
    }
    async function form(ctx, parent, latest, ticket) {
        const title = input('实际计划标题', false, 120), instructions = input('具体安排与注意事项', true, 4000), start = input('开始日期', false, 10, 'date'), end = input('结束日期', false, 10, 'date');
        for (const field of [title, instructions, start, end]) field.field.required = true;
        const first = ctx.expected_previous_version ? plusDays(ctx.calendar_today, 1) : ctx.calendar_today;
        title.field.value = latest?.title || ''; instructions.field.value = latest?.instructions || ''; start.field.value = first; end.field.value = plusDays(first, 13);
        start.field.min = first; end.field.min = first;
        let adopted = null; const aiId = Number(new URLSearchParams(location.search).get('ai_decision_id'));
        if (positive(aiId)) {
            adopted = page.check(await page.request(`/agent/artifact-decisions/${aiId}/adoption-context`)); if (!page.current(ticket)) return;
            if (adopted.actor_user_id !== page.session.accountId || adopted.target_type !== 'plan_publication' || adopted.content.source_report_id !== ctx.source_report_id) throw new Error('助手计划草稿的负责医生或来源报告不一致。');
            title.field.value = adopted.content.title; instructions.field.value = adopted.content.instructions; title.field.readOnly = instructions.field.readOnly = true;
        }
        const form = node('form'); form.append(node('h2', ctx.expected_previous_version ? '明确发布未来修订' : '明确发布首版计划'), node('p', `依据正式报告 ${ctx.source_report_id} · 当前计划第 ${ctx.expected_previous_version} 版。`));
        form.append(title.wrapper, instructions.wrapper, start.wrapper, end.wrapper); const publish = node('button', '确认发布实际计划'); publish.type = 'submit'; form.append(publish);
        form.addEventListener('submit', event => { event.preventDefault(); const id = adopted?.target_client_id || page.newId('plan');
            page.submit({ label: '正式计划版本', idField: 'client_plan_version_id', tokenField: 'plan_context', contextField: 'plan_context_digest',
                contextDigest: ctx.plan_context_digest, route: '/care/plan-versions', queryRoute: '/care/plan-versions/submissions/',
                payload: { client_plan_version_id: id, patient_id: patientId, assessment_id: assessmentId, expected_assessment_version: ctx.assessment_version,
                    expected_previous_version: ctx.expected_previous_version, expected_plan_revision: ctx.expected_plan_revision, source_report_id: ctx.source_report_id,
                    input_digest: ctx.input_digest, plan_context: ctx.plan_context, title: title.field.value, instructions: instructions.field.value,
                    start_date: start.field.value, end_date: end.field.value, source_ai_decision_id: adopted?.id || null, confirmed: true },
                confirm: '确认由本人医生发布这个实际日期计划？修订只改变未来安排，原记录与旧版本保留。', success: '实际计划版本及每日任务已发布。' });
        }); parent.append(form);
    }
    page.reload = async () => {
        const ticket = page.next(), view = page.area('clinicalInputs'), history = page.area('clinicalHistory'); view.replaceChildren(); history.replaceChildren();
        await page.pendingView(); if (!page.current(ticket)) return;
        const response = await page.request(`/care/plans?patient_id=${patientId}`); if (!page.current(ticket)) return;
        if (!Array.isArray(response.items)) throw new Error('计划列表不完整。');
        const plans = response.items.filter(row => row.assessment_id === assessmentId); plans.forEach(row => renderPlan(row, history));
        if (!plans.length) history.append(node('p', '本轮尚无已发布计划。'));
        if (page.pending) { page.say('有待确认原件，请先按原编号查询，当前禁止生成第二份提交。'); return; }
        if (!doctor) { page.say('已读取负责医生的原计划版本、收到记录与真实日期任务。'); return; }
        const ctx = page.check(await page.request(`/care/assessments/${assessmentId}/plan-context`)); if (!page.current(ticket)) return;
        if (ctx.actor_user_id !== page.session.accountId) throw new Error('实际发布医生不一致。');
        const latest = plans.flatMap(row => row.versions).sort((a, b) => b.version - a.version)[0]; await form(ctx, view, latest, ticket);
        if (page.current(ticket)) page.say('已读取正式报告与当前计划版本，可明确发布未来安排。');
    };
    page.run(page.reload);
})();
