(() => {
    'use strict';
    const { makePage, node, input, button, link, positive } = window.ClinicalBusiness;
    const page = makePage('review'); if (!page) return;
    const { patientId, assessmentId } = page, args = { patient_id: patientId, assessment_id: assessmentId };
    const base = `/care/assessments/${assessmentId}`;
    document.getElementById('clinicalNav').append(link('本轮评估', 'doctor_assessments.html', args), link('已发布报告', 'doctor_reports.html', args), link('实际计划', 'doctor_plan.html', args));
    const categories = { evidence_review: '材料审核', screening_opinion: '医生筛查意见', clinical_assessment: '临床评估', diagnosis: '诊断意见' };
    const details = (parent, title, data) => { const wrapper = node('details'); wrapper.append(node('summary', title), node('pre', JSON.stringify(data, null, 2))); parent.append(wrapper); };
    function select(label, values) {
        const wrapper = node('label', label), field = node('select'); field.setAttribute('aria-label', label);
        values.forEach(([value, text, disabled]) => { const option = node('option', text); option.value = value; option.disabled = disabled === true; field.append(option); });
        wrapper.append(field); return { wrapper, field };
    }
    async function openDraft(id) {
        return page.run(async () => {
            const ticket = page.next(), row = page.check(await page.request(`/care/reviews/${id}`)); if (!page.current(ticket)) return;
            if (row.id !== id || row.actor_user_id !== page.session.accountId || row.status !== 'draft') throw new Error('私人审核草稿归属不一致。');
            const view = page.area('clinicalInputs'); view.replaceChildren(node('h2', '本人私人审核草稿'), node('p', row.body), node('h3', '局限'), node('p', row.limitations));
            details(view, '原始材料逐项审核决定', row.decisions); details(view, '本草稿冻结的原材料', row.input_snapshot);
            if (!page.pending) view.append(button('核对并明确发布这份草稿', () => publish(row)));
            page.say('草稿仍为私人内容，尚未向用户发布。');
        });
    }
    async function publish(row) {
        if (page.pending) return;
        return page.run(async () => {
            const ticket = page.next(), ctx = page.check(await page.request(`/care/reviews/${row.id}/publication-context`)); if (!page.current(ticket)) return;
            if (ctx.review_id !== row.id || ctx.actor_user_id !== page.session.accountId || ctx.review_payload_digest !== row.payload_digest || ctx.input_digest !== row.input_digest) throw new Error('发布上下文与所选草稿不一致。');
            // Leave the exclusive request section before the separately confirmed write.
            page._publication = { row, ctx };
            const view = page.area('clinicalInputs'); view.append(node('p', `已核对当前材料，拟发布为第 ${ctx.expected_previous_report_version + 1} 版报告。`));
            view.append(button('确认发布给用户', async () => {
                const p = page._publication; if (!p || p.row.id !== row.id) return;
                const id = page.newId('report');
                await page.submit({ label: '正式报告发布', idField: 'client_publication_id', tokenField: 'publication_context', contextField: 'publication_context_digest',
                    contextDigest: ctx.publication_context_digest, route: '/care/review-publications', queryRoute: '/care/review-publications/submissions/',
                    expected: { body: row.body, limitations: row.limitations, category: row.category, decisions: row.decisions, source_ai_decision_id: row.source_ai_decision_id ?? null },
                    payload: { client_publication_id: id, patient_id: patientId, assessment_id: assessmentId, review_id: row.id,
                        expected_assessment_version: ctx.expected_assessment_version, expected_previous_report_version: ctx.expected_previous_report_version,
                        input_digest: ctx.input_digest, publication_context: ctx.publication_context, confirmed: true },
                    confirm: '确认作为实际负责医生发布当前草稿和逐项决定？用户将看到正式意见，原始提交与质量结论仍保留。', success: '正式报告已发布。' });
            }));
        });
    }
    async function questionForm(ctx, parent, ticket) {
        const sources = ctx.submissions.map(row => ['submission:' + row.submission_id, `提交原件 ${row.submission_id}`]);
        if (ctx.background?.visibility === 'shared') for (const key of Object.keys(ctx.background.fields || {})) sources.push(['background:' + key, `共享背景 ${key}`]);
        if (!sources.length || page.pending) return;
        const form = node('form'), source = select('具体待补充材料', sources), question = input('向用户或监护人提出的具体问题', true, 2000);
        question.field.required = true; form.append(node('h2', '对具体材料补问'), source.wrapper, question.wrapper); const send = node('button', '确认发出具体补问'); send.type = 'submit'; form.append(send);
        let adopted=null;const aiId=Number(new URLSearchParams(location.search).get('ai_decision_id'));
        if(positive(aiId)){const value=page.check(await page.request(`/agent/artifact-decisions/${aiId}/adoption-context`));if(!page.current(ticket))return;
            if(value.target_type==='review_question'){if(value.actor_user_id!==page.session.accountId||!sources.some(([key])=>key===`${value.content.source_type}:${value.content.source_key}`))throw Error('草稿问题的原材料不一致。');
                adopted=value;source.field.value=`${value.content.source_type}:${value.content.source_key}`;source.field.disabled=true;question.field.value=value.content.question;question.field.readOnly=true;}}
        form.addEventListener('submit', event => { event.preventDefault(); const split = source.field.value.indexOf(':'), id = adopted?.target_client_id || page.newId('question');
            page.submit({ label: '医生具体补问', idField: 'client_question_id', tokenField: 'review_context', contextField: 'review_context_digest',
                contextDigest: ctx.review_context_digest, route: '/care/clarifications', queryRoute: '/care/clarifications/submissions/',
                payload: { client_question_id: id, patient_id: patientId, assessment_id: assessmentId,
                    expected_assessment_version: ctx.assessment_version, input_digest: ctx.input_digest, review_context: ctx.review_context,
                    source_type: source.field.value.slice(0, split), source_key: source.field.value.slice(split + 1),
                    question: question.field.value, source_ai_decision_id: adopted?.id || null, confirmed: true },
                confirm: '确认以本人医生身份发出针对这份原材料的问题？原背景资料和原测量结果不会改写。', success: '具体补问已发出。' });
        }); parent.append(form);
    }
    async function reviewForm(ctx, parent, ticket) {
        if (!ctx.submissions.length) { parent.append(node('p', '尚无实际提交原件，暂不能保存材料审核。')); return; }
        const form = node('form'), body = input('实际医生意见', true, 12000), limitations = input('本次审核局限', true, 4000);
        const category = select('意见类别', ctx.allowed_categories.filter(value => categories[value]).map(value => [value, categories[value]]));
        body.field.required = limitations.field.required = true; const decisions = [];
        form.append(node('h2', '逐项材料审核'), category.wrapper);
        for (const row of ctx.submissions) {
            const card = node('article'); card.append(node('h3', `原件 ${row.submission_id} · ${row.quality_status}`));
            details(card, '实际结果、原始作答与执行资料', { result: row.server_result, content: row.content, execution: row.execution_metadata, quality_reasons: row.quality_reasons, comparability: row.comparability_status });
            const decision = select(`原件 ${row.submission_id} 的审核决定`, [['', '请选择实际决定'], ['accepted', '采纳', row.quality_status !== 'valid'], ['needs_repeat', '需要重测'], ['rejected', '退回']]);
            decision.field.required = true; const reason = input(`原件 ${row.submission_id} 的实际原因`, true, 2000); reason.field.required = true;
            card.append(decision.wrapper, reason.wrapper); form.append(card); decisions.push({ row, decision: decision.field, reason: reason.field });
        }
        form.append(body.wrapper, limitations.wrapper); let adopted = null;
        const aiId = Number(new URLSearchParams(location.search).get('ai_decision_id'));
        if (positive(aiId)) {
            adopted = page.check(await page.request(`/agent/artifact-decisions/${aiId}/adoption-context`)); if (!page.current(ticket)) return;
            if (adopted.id !== aiId || adopted.actor_user_id !== page.session.accountId) throw new Error('助手决定不属于当前医生审核。');
            if(adopted.target_type==='review_draft'){body.field.value = adopted.content.text; body.field.readOnly = true; form.append(node('p', '已载入本人核对的助手草稿；仍需逐项审核、填写局限并明确保存和发布。'));}else adopted=null;
        }
        const save = node('button', '确认保存本人私人审核草稿'); save.type = 'submit'; form.append(save);
        form.addEventListener('submit', event => { event.preventDefault(); const id = adopted?.target_client_id || page.newId('review');
            page.submit({ label: '私人审核草稿', idField: 'client_review_id', tokenField: 'review_context', contextField: 'review_context_digest',
                contextDigest: ctx.review_context_digest, route: '/care/reviews', queryRoute: '/care/reviews/submissions/',
                payload: { client_review_id: id, patient_id: patientId, assessment_id: assessmentId, expected_assessment_version: ctx.assessment_version,
                    input_digest: ctx.input_digest, review_context: ctx.review_context, category: category.field.value, body: body.field.value,
                    limitations: limitations.field.value, decisions: decisions.map(item => ({ submission_id: item.row.submission_id,
                        assessment_item_id: item.row.assessment_item_id, attempt_id: item.row.attempt_id, decision: item.decision.value, reason: item.reason.value })),
                    source_ai_decision_id: adopted?.id || null, confirmed: true },
                confirm: '确认本次实际材料判断、医生意见和局限，并保存为本人私人草稿？保存后仍需明确发布。', success: '本人私人草稿已保存，尚未发布。' });
        }); parent.append(form);
    }
    page.reload = async () => {
        const ticket = page.next(); page._publication = null; const view = page.area('clinicalInputs'), history = page.area('clinicalHistory'); view.replaceChildren(); history.replaceChildren();
        await page.pendingView(); if (!page.current(ticket)) return;
        const [drafts, reports, questions, context] = await Promise.all([page.request(base + '/reviews'), page.request(base + '/reports'), page.request(base + '/clarifications'), page.request(base + '/review-context').catch(error => ({ unavailable: error }))]);
        if (!page.current(ticket)) return;
        for (const payload of [drafts, reports, questions]) if (!Array.isArray(payload.items)) throw new Error('审核历史列表不完整。');
        history.append(node('h2', '具体补问与不可变回复'));
        for (const row of questions.items) { page.check(row); const card = node('article'); card.append(node('h3', `问题 ${row.id} · ${row.source_type} / ${row.source_key}`), node('p', row.question));
            for (const reply of row.replies || []) { page.check(reply); card.append(node('p', `回复第 ${reply.revision} 版 · ${reply.answer_status} · 实际账号 ${reply.actor_user_id}`), node('p', reply.answer ?? '未提供，情况未知')); } history.append(card); }
        history.append(node('h2', '本人私人审核草稿'));
        for (const row of drafts.items) { page.check(row); if (row.actor_user_id !== page.session.accountId) throw new Error('私人草稿实际作者不一致。'); history.append(button(`${categories[row.category] || row.category} · 草稿 ${row.id}`, () => openDraft(row.id))); }
        history.append(node('h2', '已发布正式版本'));
        for (const row of reports.items) { page.check(row); const card = node('article'); card.append(node('h3', `${categories[row.category] || row.category} · 第 ${row.version} 版`), node('p', row.body), node('p', row.limitations)); history.append(card); }
        if (context.unavailable) { page.say(context.unavailable.message); return; }
        page.check(context); if (context.responsible_doctor_id !== page.session.accountId || !Array.isArray(context.submissions) || !Array.isArray(context.allowed_categories)) throw new Error('当前负责医生与输入不一致。');
        view.append(node('h2', `本轮实际材料 · 版本 ${context.assessment_version}`));
        if (context.demonstration_only) view.append(node('p', '当前为合成资料演示，不能发布正式临床评估或诊断。'));
        details(view, '实际项目、尝试与已共享背景', { items: context.items, attempts: context.attempts, background: context.background });
        if (page.pending) { page.say('有待确认原件，请先按原编号查询；当前禁止生成第二份提交。'); return; }
        await questionForm(context, view, ticket); if(!page.current(ticket))return; await reviewForm(context, view, ticket);
        if (page.current(ticket)) page.say('已读取实际材料、补问回复、私人草稿和已发布报告。');
    };
    page.run(page.reload);
})();
