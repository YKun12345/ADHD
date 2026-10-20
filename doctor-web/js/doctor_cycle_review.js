(() => {
    'use strict';
    const { makePage, node, input, button, link } = window.ClinicalBusiness;
    const page = makePage('cycle', ['researcher', 'patient']); if (!page) return;
    const doctor = page.session.role === 'researcher', { patientId, cycleId } = page;
    const adoptionId = Number(new URLSearchParams(location.search).get('ai_decision_id'));
    const labels = { continue: '继续并发布后续日期计划', adjust: '调整未来安排', end: '结束本计划或自助周期', next_round: '进入下一轮' };
    const recordLabels = { mood_tag: '心情', focus_minutes: '专注时长（分钟）', note: '记录说明', test_score: '自报测试分数',
        activities: '当天活动', is_medication: '是否用药（本人记录）', medication_dosage: '用药剂量（本人记录）',
        attention_rating: '注意力自评', hyperactivity_rating: '多动自评', impulsivity_rating: '冲动自评',
        emotion_rating: '情绪自评', task_completion_rating: '任务完成自评', sleep_quality: '睡眠情况', appetite_quality: '食欲情况',
        has_conflict: '是否发生冲突', was_criticized: '是否受到批评', side_effects: '不适或副作用（本人记录）', special_events: '特别事件', highlights: '当天亮点' };
    function recordView(parent, content) {
        const fields = node('div'), unknown = [];
        fields.className = 'daily-record-fields';
        for (const [key, label] of Object.entries(recordLabels)) {
            const value = content?.[key];
            if (value == null || value === '') { unknown.push(label); continue; }
            fields.append(node('p', `${label}：${Array.isArray(value) ? value.join('、') || '已记录为空' : typeof value === 'boolean' ? value ? '是' : '否' : value}`));
        }
        parent.append(fields);
        if (unknown.length) {
            const missing = node('details');
            missing.append(node('summary', `未记录项目（${unknown.length}项）`), node('p', unknown.join('、') + '：未记录，保持未知。'));
            parent.append(missing);
        }
    }
    const plusDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
    function links(row, parent) {
        if (row.next_assessment_id && doctor) parent.append(link('打开下一轮真实草案并明确发布', 'doctor_assessments.html', { patient_id: patientId, assessment_id: row.next_assessment_id }));
        if (row.next_plan_version_id && row.assessment_id) parent.append(link('打开后续真实计划', doctor ? 'doctor_plan.html' : 'patient_plan.html', { patient_id: patientId, assessment_id: row.assessment_id }));
        if (row.next_cycle_id) parent.append(link('打开后续真实周期', doctor ? 'doctor_cycle_review.html' : 'patient_cycle_review.html', { patient_id: patientId, cycle_id: row.next_cycle_id }));
    }
    function form(ctx, cycle, parent, adoption) {
        const form = node('form'), select = node('select'); select.setAttribute('aria-label', '实际阶段决定');
        for (const value of ctx.allowed_decisions) { const option = node('option', labels[value]); option.value = value; select.append(option); }
        const body = input('实际阶段复核意见', true, 8000), limitations = input('阶段材料局限', true, 2000), reason = input('后续决定的实际原因', true, 2000),
            title = input('后续实际计划标题', false, 120), instructions = input('后续安排与注意事项', true, 4000), start = input('后续开始日期', false, 10, 'date'), end = input('后续结束日期', false, 10, 'date');
        for (const field of [body, limitations, reason]) field.field.required = true;
        if (adoption) { body.field.value = adoption.content.text; body.field.readOnly = true;
            form.append(node('p', '已带入你核对的周期摘要。修改正文请回星仔重新核对；仍须填写局限、原因并明确确认阶段决定，日期原件不会改写。')); }
        const latest = ctx.input_snapshot.plan?.versions?.slice(-1)[0]; title.field.value = latest?.title || ''; instructions.field.value = latest?.instructions || '';
        const first = plusDays(cycle.end_date > ctx.input_snapshot.calendar_today ? cycle.end_date : ctx.input_snapshot.calendar_today, 1);
        start.field.value = first; end.field.value = plusDays(first, 13); start.field.min = end.field.min = first;
        form.append(node('h2', doctor ? '负责医生明确阶段决定' : '自助周期阶段决定'), select, body.wrapper, limitations.wrapper, reason.wrapper, title.wrapper, instructions.wrapper, start.wrapper, end.wrapper);
        const update = () => { const plan = ['continue', 'adjust'].includes(select.value), dates = plan || cycle.cycle_type === 'self' && select.value === 'next_round';
            for (const field of [title, instructions]) { field.wrapper.hidden = !plan; field.field.required = plan; }
            for (const field of [start, end]) { field.wrapper.hidden = !dates; field.field.required = dates; }
            // Adjustment may begin tomorrow; continuation must follow the current cycle.
            if (select.value === 'adjust') { start.field.min = plusDays(ctx.input_snapshot.calendar_today, 1); end.field.min = start.field.min; }
            else { start.field.min = end.field.min = first; }
        };
        select.addEventListener('change', update); update(); const confirm = node('button', '明确确认实际阶段决定'); confirm.type = 'submit'; form.append(confirm);
        form.addEventListener('submit', event => { event.preventDefault(); const id = adoption ? adoption.target_client_id : page.newId('stage'), plan = ['continue', 'adjust'].includes(select.value), dates = { start_date: start.field.value, end_date: end.field.value };
            page.submit({ label: '阶段复核决定', idField: 'client_cycle_review_id', tokenField: 'review_context', contextField: 'review_context_digest',
                contextDigest: ctx.review_context_digest, route: '/care/cycle-reviews', queryRoute: '/care/cycle-reviews/submissions/',
                payload: { client_cycle_review_id: id, patient_id: patientId, cycle_id: cycleId, expected_previous_version: ctx.expected_previous_version,
                    input_digest: ctx.input_digest, review_context: ctx.review_context, decision: select.value,
                    body: body.field.value, limitations: limitations.field.value, reason: reason.field.value,
                    followup_plan: plan ? { ...dates, title: title.field.value, instructions: instructions.field.value } : null,
                    next_cycle: !plan && cycle.cycle_type === 'self' && select.value === 'next_round' ? dates : null, confirmed: true,
                    ...(adoption ? { source_ai_decision_id: adoption.id } : {}) },
                confirm: `确认“${labels[select.value]}”？依据当前实际日期和资料形成不可变决定，原始记录保留。下一轮评估草案仍需另行发布。`, success: '实际阶段决定与后续业务已接通。' });
        }); parent.append(form);
    }
    page.reload = async () => {
        const ticket = page.next(), view = page.area('clinicalInputs'), history = page.area('clinicalHistory'); view.replaceChildren(); history.replaceChildren();
        await page.pendingView(); if (!page.current(ticket)) return;
        const cycle = await page.request(`/care/cycles/${cycleId}`); if (!page.current(ticket)) return;
        if (cycle.id !== cycleId || cycle.patient_id !== patientId || !Array.isArray(cycle.records)) throw new Error('实际周期与当前档案不一致。');
        view.append(node('h2', `${cycle.cycle_type === 'professional' ? '专业计划' : '自助'}周期 ${cycle.id} · ${cycle.start_date} 至 ${cycle.end_date}`));
        view.append(node('p', `截至 ${cycle.summary.as_of_date}，实际记录 ${cycle.summary.completed_count} / ${cycle.summary.due_count} 天；缺失保持未记录，不作为零分。`), node('p', `缺失日期：${cycle.summary.missing_dates.join('、') || '无'}`));
        for (const record of cycle.records) {
            if (record.patient_id !== patientId || record.cycle_id !== cycleId) throw new Error('日期原件与周期不一致。');
            const card = node('article'); card.append(node('h3', `${record.record_date} · 第 ${record.revision} 版`));
            recordView(card, record.content);
            card.append(button('读取这一天的全部修订原件', () => page.run(async () => {
                const active = page.next(), result = await page.request(`/care/cycles/${cycleId}/daily-history?record_date=${record.record_date}`); if (!page.current(active)) return;
                if (!Array.isArray(result.items)) throw new Error('日期修订历史不完整。');
                for (const row of result.items) if (row.patient_id !== patientId || row.cycle_id !== cycleId || row.record_date !== record.record_date) throw new Error('历史日期原件来源不一致。');
                const originals = node('details'); originals.open = true; originals.append(node('summary', '该日期不可变修订原件'));
                for (const row of result.items) {
                    const revision = node('section'); revision.append(node('h4', `第 ${row.revision} 版 · ${row.record_date}`));
                    recordView(revision, row.content); originals.append(revision);
                }
                card.append(originals);
            }))); view.append(card);
        }
        const response = await page.request(`/care/cycles/${cycleId}/reviews`); if (!page.current(ticket)) return;
        if (response.cycle_id !== cycleId || response.patient_id !== patientId || !Array.isArray(response.items)) throw new Error('阶段历史归属不一致。');
        history.append(node('h2', '不可变阶段决定'));
        for (const row of response.items) { if (row.patient_id !== patientId || row.cycle_id !== cycleId) throw new Error('阶段决定原件不一致。');
            const card = node('article'); card.append(node('h3', labels[row.decision]), node('p', `实际确认账号 ${row.actor_user_id}${row.professional_confirmation ? ' · 医生专业确认' : ' · 自助决定'}`), node('p', row.body), node('p', row.limitations), node('p', row.reason)); links(row, card); history.append(card); }
        if (response.items.length) { page.say('已读取原阶段决定，请从真实后续业务入口继续。'); return; }
        if (page.pending) { page.say('有待确认阶段原件，请先按原编号查询。'); return; }
        if (!doctor && cycle.cycle_type === 'professional') { page.say('已读取负责医生计划的实际周期，阶段专业决定由医生确认。'); return; }
        const ctx = await page.request(`/care/cycles/${cycleId}/review-context`); if (!page.current(ticket)) return;
        if (ctx.cycle_id !== cycleId || ctx.patient_id !== patientId || ctx.actor_user_id !== page.session.accountId || !Array.isArray(ctx.allowed_decisions)) throw new Error('当前阶段决定上下文不一致。');
        let adoption = null;
        if (Number.isInteger(adoptionId) && adoptionId > 0) {
            adoption = await page.request(`/agent/artifact-decisions/${adoptionId}/adoption-context`); if (!page.current(ticket)) return;
            if (adoption.id !== adoptionId || adoption.actor_user_id !== page.session.accountId || adoption.patient_id !== patientId || adoption.cycle_id !== cycleId ||
                adoption.target_type !== 'cycle_review' || typeof adoption.content?.text !== 'string') throw new Error('周期摘要来源与当前实际周期不一致。');
        }
        form(ctx, cycle, view, adoption); page.say('已读取实际日期资料，可以明确确认阶段决定。');
    };
    page.run(page.reload);
})();
