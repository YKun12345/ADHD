/* Read-only W05 evidence. Every render stays bound to this page's account and request epoch. */
(() => {
    'use strict';
    const shell = document.getElementById('careShell');
    if (!shell) return;
    const guard = window.SessionGuard;
    const api = window.API?.CareWorkflow;
    const session = guard?.captureSession();
    const doctor = shell.dataset.careRole === 'doctor';
    const $ = id => document.getElementById(id);
    const privateViews = ['careAttention', 'careCycles', 'careEvidence', 'careCycleDetails', 'careHistory'];
    let epoch = 0, evidenceEpoch = 0, cycleEpoch = 0, historyEpoch = 0, stopped = false;
    let patientId = null, attentionItems = [], cycles = [], selectedCycle = null;
    function clearViews() {
        privateViews.forEach(id => $(id)?.replaceChildren());
        $('careCoverage').textContent = '';
        attentionItems = []; cycles = []; selectedCycle = null;
        evidenceEpoch++; cycleEpoch++; historyEpoch++;
    }
    function stop() {
        stopped = true; epoch++; clearViews(); patientId = null;
        $('carePatient')?.replaceChildren();
        $('careRefresh').disabled = true;
        $('careMessage').textContent = '页面已停止读取，请重新打开页面。';
    }
    function current(ticket = epoch) {
        return !stopped && ticket === epoch && guard.isCurrentSession(session);
    }
    function message(text) { $('careMessage').textContent = text; }
    function node(tag, text, className) {
        const result = document.createElement(tag);
        if (text !== undefined && text !== null) result.textContent = String(text);
        if (className) result.className = className;
        return result;
    }
    function field(parent, label, value) { parent.append(node('p', `${label}：${value ?? '未知'}`)); }
    function json(parent, label, value) {
        parent.append(node('h4', label), node('pre', JSON.stringify(value ?? null, null, 2)));
    }
    function originals(parent, entries) {
        const details = node('details');
        details.append(node('summary', doctor ? '展开原始材料，核对本次提交' : '查看已保存的原始材料'));
        details.append(node('p', '以下是当次保存的字段与数值，便于核对。空值表示未报告；字段名和原始数值不构成诊断或医生验收。'));
        entries.forEach(([label, value]) => json(details, label, value));
        parent.append(details);
    }
    const statusLabels = { open: '待处理', acknowledged: '已确认关注', in_progress: '旧版处理中', closed_with_reason: '已说明原因关闭', suspended: '已暂停', active: '进行中',
        closed_self: '自助材料已齐备', under_review: '待医生审核', closed: '旧版已关闭', resolved: '已解决', committed: '已保存' };
    const suspensionLabels = { original_authorization_replaced: '原授权已变化，请核对授权；新授权不会自动恢复旧周期',
        responsibility_transferred: '此事项责任已由新医生实际接受，原来源与原负责医生保留；后续处理请查看继任事项',
        original_authorization_invalid: '原授权已失效', original_authority_invalid: '原授权或身份关系已失效，旧安排已暂停',
        original_authorization_unavailable: '原授权或身份关系已失效，旧周期仅可查看历史', original_actor_changed: '原记录账号与当前账号不同' };
    const authorityReasons = { doctor_qualification_expired:'医生资格有效期已到', institution_membership_expired:'机构成员资格有效期已到',
        guardian_relationship_expired:'监护关系有效期已到', patient_identity_expired:'档案访问身份有效期已到', clinical_relationship_expired:'医患关系有效期已到',
        purpose_consent_expired:'用途同意有效期已到', account_disabled:'原账号已停用', original_account_unavailable:'原账号不可用', original_authority_invalid:'原身份或授权不可用' };
    const qualityReasons = { unknown_input: '输入方式未确认', unknown_device: '设备资料未确认', unknown_clock: '计时信息未确认',
        execution_interrupted: '执行过程有中断', practice_evidence_incomplete: '练习记录不完整', practice_not_passed: '练习未通过',
        assistance_requires_review: '存在协助操作，需要结合情况查看', high_omissions: '漏答较多', high_false_starts: '提前点击较多',
        low_accuracy: '正确率较低', no_correct_trials: '没有正确作答记录', nonpositive_response_time: '部分反应时间需要核对' };
    const qualityReason = reason => qualityReasons[reason] ?? '请查看原件中的质量说明';
    function list(payload) {
        if (!Array.isArray(payload?.items)) throw new Error('返回资料结构不一致，资料已隐藏。');
        return payload.items;
    }
    const id = value => Number.isSafeInteger(value) && value > 0;
    const mismatch = () => { throw new Error('返回资料与当前档案或原责任范围不一致，资料已隐藏。'); };
    function error(error, ticket = epoch) {
        if (!current(ticket)) return;
        clearViews(); message(error?.message || '读取失败，请重试。');
    }
    function coverage(value) {
        if (value?.status === 'per_attention') return '各事项按创建时保存的配置显示，当前配置不会改写原窗口。';
        if (value?.status === 'not_configured' || !value?.status) return '服务覆盖未配置；当前没有响应时限或紧急处置承诺。';
        const row = value.coverage;
        if (value.status !== 'configured' || !row || !id(row.version) || row.timezone !== 'Asia/Shanghai' || !Array.isArray(row.working_periods)) mismatch();
        const days = ['周一','周二','周三','周四','周五','周六','周日'];
        const byDay = new Map();
        row.working_periods.forEach(period => {
            if (!days[period.weekday]) mismatch();
            if (!byDay.has(period.weekday)) byDay.set(period.weekday, []);
            byDay.get(period.weekday).push(`${period.start}-${period.end}`);
        });
        const groups = new Map();
        [...byDay.keys()].sort((a,b) => a-b).forEach(day => {
            const times = byDay.get(day).sort().join('、');
            if (!groups.has(times)) groups.set(times, []);
            groups.get(times).push(day);
        });
        const periods = [...groups].map(([times, values]) => {
            const consecutive = values.length > 1 && values.every((day,index) => day === values[0]+index);
            return `${consecutive ? days[values[0]] + '至' + days[values[values.length-1]] : values.map(day => days[day]).join('、')} ${times}`;
        }).join('；');
        return `机构 ${row.institution_id} · 医生账号 ${row.doctor_user_id} · 版本 ${row.version}；${periods}（北京时间）；期望窗口 ${row.expected_response_working_minutes} 个工作分钟。现实流程：${row.escalation_instructions}。配置不表示真实机构上线准入已核验。`;
    }
    function validAttention(item) {
        if (!id(item.id) || !id(item.patient_id) || !id(item.assessment_id)
            || !['patient_self', 'doctor'].includes(item.owner_kind)
            || !Array.isArray(item.allowed_actions)) mismatch();
        if (doctor && (item.owner_kind !== 'doctor' || item.responsible_doctor_id !== session.accountId || !id(item.relationship_id))) mismatch();
        if (!doctor && item.patient_id !== patientId) mismatch();
        if (item.owner_kind === 'patient_self' && (item.responsible_doctor_id != null || item.relationship_id != null)) mismatch();
    }
    function renderAttention(items) {
        const parent = $('careAttention'); parent.replaceChildren();
        if (!items.length) { parent.append(node('p', '当前没有可读取的关注项。')); return; }
        items.forEach(item => {
            const card = node('article', null, 'care-card');
            card.append(node('h3', `关注项 #${item.id} · 档案 #${item.patient_id}`));
            field(card, '状态 / 版本', `${statusLabels[item.status] ?? item.status} / ${item.version}`);
            field(card, '负责人', item.owner_kind === 'patient_self' ? '本人自助（无负责医生）' : `原负责医生 #${item.responsible_doctor_id}`);
            field(card, '对应评估', `第 ${item.assessment_id} 轮`);
            field(card, '服务覆盖', coverage(item.response_coverage));
            const deadline = item.expected_response_at;
            if (deadline != null && (!/(Z|[+-]\d{2}:\d{2})$/.test(deadline) || !Number.isFinite(Date.parse(deadline)))) mismatch();
            field(card, '原期望处理截止', deadline == null ? '未配置' : new Date(Date.parse(deadline) + 8*3600000).toISOString().slice(0,16).replace('T',' ') + '（北京时间）');
            if (item.current_service_coverage) {
                const same = item.current_service_coverage.status === 'configured' && item.response_coverage?.status === 'configured' &&
                    item.current_service_coverage.coverage.id === item.response_coverage.coverage.id && item.current_service_coverage.coverage.version === item.response_coverage.coverage.version;
                field(card, '当前配置（不改写原窗口）', same ? '与创建时配置相同，原窗口保持不变。' : coverage(item.current_service_coverage));
            }
            if (item.suspension_reason) field(card, '暂停原因', suspensionLabels[item.suspension_reason] ?? item.suspension_reason);
            if (item.suspension_observation) {
                const observation = item.suspension_observation;
                if (observation.human_action !== false || observation.system_principal !== 'care_authority_reconciler' ||
                    !/(Z|[+-]\d{2}:\d{2})$/.test(observation.observed_at) || !Number.isFinite(Date.parse(observation.observed_at))) mismatch();
                field(card, '后台核对时间', new Date(Date.parse(observation.observed_at)+8*3600000).toISOString().slice(0,16).replace('T',' ')+'（北京时间）');
                field(card, '核对结果', authorityReasons[observation.reason_code] || '原身份或授权不可用');
            }
            if (item.overdue_observation) {
                const observation = item.overdue_observation;
                if (item.owner_kind !== 'doctor' || observation.system_principal !== 'attention_deadline_monitor' || observation.human_action !== false ||
                    !['requires_institutional_action','historical'].includes(observation.status) || observation.original_deadline !== item.expected_response_at ||
                    observation.external_delivery_status !== 'not_configured' || !/(Z|[+-]\d{2}:\d{2})$/.test(observation.observed_at) ||
                    !Number.isFinite(Date.parse(observation.observed_at)) || Date.parse(observation.observed_at) < Date.parse(observation.original_deadline) ||
                    typeof observation.institutional_instructions !== 'string') mismatch();
                field(card, '原窗口超时记录', observation.status === 'requires_institutional_action' ? '已超过原期望窗口，站内升级记录已保存；事项仍待机构处理。' : '历史超时记录已保留，请结合当前事项状态查看。');
                field(card, '超时核对时间', new Date(Date.parse(observation.observed_at)+8*3600000).toISOString().slice(0,16).replace('T',' ')+'（北京时间）');
                field(card, '机构现实流程', observation.institutional_instructions);
                field(card, '外部通知', '未配置');
            }
            (Array.isArray(item.quality_reasons) ? item.quality_reasons : []).forEach(reason => field(card, '质量说明', qualityReason(reason)));
            const source = node('details');
            source.append(node('summary', '查看来源记录编号'));
            field(source, '原事件编号', item.source_event_id);
            if (item.submission_id) field(source, '原提交编号', item.submission_id);
            card.append(source);
            if (item.submission_id && item.allowed_actions.includes('read_evidence')) {
                const button = node('button', '读取原提交材料'); button.type = 'button';
                button.dataset.evidenceId = item.submission_id;
                button.addEventListener('click', () => readEvidence(item)); card.append(button);
            }
            const link = node('a', '打开本轮评估列表'); link.dataset.assessmentLink = '';
            link.href = `${doctor ? 'doctor' : 'patient'}_assessments.html?patient_id=${encodeURIComponent(item.patient_id)}`;
            card.append(link); parent.append(card);
        });
    }
    async function readEvidence(item) {
        const ticket = epoch, operation = ++evidenceEpoch;
        $('careEvidence').replaceChildren(); message('正在读取原提交材料…');
        try {
            if (!current(ticket) || !attentionItems.includes(item)) return;
            validAttention(item);
            const result = await api.getEvidence(item.submission_id);
            if (!current(ticket) || operation !== evidenceEpoch) return;
            const context = result?.context, ack = result?.ack;
            if (result?.submission_id !== item.submission_id || ack?.submission_id !== item.submission_id
                || context?.patient_id !== item.patient_id || ack?.patient_id !== item.patient_id
                || context?.assessment_id !== item.assessment_id || ack?.assessment_id !== item.assessment_id
                || !['scale', 'cognitive'].includes(result?.server_result?.kind) || result.server_result.legacy !== false) mismatch();
            const parent = $('careEvidence');
            parent.append(node('h3', '已保存结果'));
            const execution = { submitted: '已提交' }, quality = { valid: '符合规则', limited: '有局限', invalid: '未通过质量规则' };
            const acceptance = { pending_review: '待医生验收', accepted: '医生已验收', not_required: '无需医生验收',
                not_applicable: '不适用', needs_repeat: '需要重新完成', rejected: '医生未验收' };
            field(parent, '执行状态', execution[ack.execution_status] ?? ack.execution_status);
            field(parent, '质量状态', quality[ack.quality_status] ?? ack.quality_status);
            field(parent, '验收状态', acceptance[ack.acceptance_status] ?? ack.acceptance_status);
            field(parent, '服务器提交时间（UTC）', ack.committed_at);
            field(parent, '评估状态 / 版本', `${statusLabels[ack.assessment_status] ?? ack.assessment_status ?? '未知'} / ${ack.assessment_version ?? '未知'}`);
            parent.append(node('h4', '质量说明'));
            (Array.isArray(ack.quality_reasons) ? ack.quality_reasons : []).forEach(reason => parent.append(node('p', qualityReason(reason))));
            const saved = result.server_result;
            if (saved.kind === 'scale') {
                field(parent, '量表', saved.scale_type ?? '未提供名称');
                field(parent, '总分', typeof saved.total_score === 'number' ? `${saved.total_score} 分` : '未知');
                const answers = saved.score_json?.answers;
                if (Array.isArray(answers)) field(parent, '已保存作答', `${answers.length} 项`);
            } else {
                const tasks = { reaction: '反应抑制', stroop: '颜色干扰', flanker: '箭头抗干扰', nback: '两步位置记忆', trail: '连线', digit: '数字广度' };
                field(parent, '认知任务', tasks[saved.test_type] ?? saved.result_json?.test_name ?? '认知任务');
                const metrics = saved.result_json?.raw_result;
                if (typeof metrics?.total_trials !== 'number' && typeof saved.result_json?.actual_trials === 'number') {
                    field(parent, '已保存试次', `${saved.result_json.actual_trials} 次`);
                }
                const labels = { total_trials: ['已保存试次', ' 次'], correct_trials: ['正确试次', ' 次'],
                    accuracy: ['正确率', '%'], average_reaction_time_ms: ['平均反应时间', ' 毫秒'],
                    commission_errors: ['冲动错误', ' 次'], omission_errors: ['遗漏错误', ' 次'],
                    highest_span: ['最高广度', ''], correct_digits: ['正确替换', ' 项'], total_digits: ['替换总数', ' 项'] };
                Object.entries(labels).forEach(([key, [label, unit]]) => {
                    if (typeof metrics?.[key] === 'number') field(parent, label, `${metrics[key]}${unit}`);
                });
            }
            if (result.client_evidence?.note != null) field(parent, '原提交备注', result.client_evidence.note);
            originals(parent, [['服务器保存的当次结果', saved], ['当次提交的原始材料', result.client_evidence]]);
            message('已读取原提交材料。筛查结果不等同于临床诊断。');
        } catch (failure) { if (operation === evidenceEpoch) error(failure, ticket); }
    }
    function validCycle(cycle, expectedId) {
        if (!id(cycle?.id) || cycle.patient_id !== patientId || (expectedId && cycle.id !== expectedId)
            || cycle.cycle_type !== 'self' || cycle.responsible_doctor_id != null || cycle.plan_version_id != null
            || !/^\d{4}-\d{2}-\d{2}$/.test(cycle.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(cycle.end_date)) mismatch();
    }
    function renderCycles(items) {
        const parent = $('careCycles'); parent.replaceChildren();
        if (!items.length) { parent.append(node('p', '尚无真实日期自助周期。')); return; }
        items.forEach(cycle => {
            const card = node('article', null, 'care-card');
            card.append(node('h3', `自助周期 #${cycle.id}`));
            field(card, '实际日期', `${cycle.start_date} 至 ${cycle.end_date}`);
            field(card, '日历时区', cycle.calendar_timezone);
            field(card, '处理状态', statusLabels[cycle.processing_status] ?? cycle.processing_status);
            const button = node('button', '读取日期与覆盖率'); button.type = 'button'; button.dataset.cycleId = cycle.id;
            button.addEventListener('click', () => readCycle(cycle)); card.append(button);
            const review=node('a','阶段复核与下一步');review.href=`${doctor?'doctor':'patient'}_cycle_review.html?patient_id=${patientId}&cycle_id=${cycle.id}`;card.append(review);parent.append(card);
        });
    }
    function validRecord(record, cycle, date) {
        if (record?.patient_id !== patientId || record.cycle_id !== cycle.id || record.legacy !== false
            || !Number.isSafeInteger(record.revision) || record.revision < 1
            || !/^\d{4}-\d{2}-\d{2}$/.test(record.record_date) || record.record_date < cycle.start_date
            || record.record_date > cycle.end_date || (date && record.record_date !== date)) mismatch();
    }
    function renderRecord(parent, record) {
        const card = node('article', null, 'care-card');
        card.append(node('h4', `${record.record_date} · 修订 ${record.revision}${record.is_backfill ? ' · 补录' : ''}`));
        field(card, '用户报告的原记录时间', record.recorded_at ?? '未知（未报告）');
        field(card, '服务器实际提交时间（UTC）', record.submitted_at);
        field(card, '提交状态', statusLabels[record.submission_status] ?? record.submission_status);
        const content = record.content || {};
        const labels = { mood_tag: '心情', note: '备注', test_score: '任务分数', medication_dosage: '用药剂量',
            attention_rating: '注意力自评', hyperactivity_rating: '活动水平自评', impulsivity_rating: '冲动程度自评',
            emotion_rating: '情绪自评', task_completion_rating: '任务完成自评', sleep_quality: '睡眠', appetite_quality: '食欲',
            side_effects: '身体不适或副作用', special_events: '特殊事件', highlights: '今日亮点' };
        if (Object.hasOwn(content, 'focus_minutes')) field(card, '专注时长', content.focus_minutes == null ? '未报告' : `${content.focus_minutes} 分钟`);
        Object.entries(labels).forEach(([key, label]) => { if (content[key] != null) field(card, label, content[key]); });
        [['is_medication', '当日是否用药'], ['has_conflict', '是否发生冲突'], ['was_criticized', '是否受到批评']].forEach(([key, label]) => {
            if (typeof content[key] === 'boolean') field(card, label, content[key] ? '是' : '否');
        });
        if (Array.isArray(content.activities)) field(card, '活动', content.activities.join('、'));
        originals(card, [['本日期修订保存的内容', content]]); parent.append(card); return card;
    }
    async function readCycle(cycle) {
        const ticket = epoch, operation = ++cycleEpoch; historyEpoch++;
        selectedCycle = null; $('careCycleDetails').replaceChildren(); $('careHistory').replaceChildren();
        message('正在读取真实日期周期…');
        try {
            if (!current(ticket) || !cycles.includes(cycle)) return;
            const detail = await api.getCycle(cycle.id);
            if (!current(ticket) || operation !== cycleEpoch) return;
            validCycle(detail, cycle.id);
            if (!Array.isArray(detail.records) || !Array.isArray(detail.summary?.missing_dates)) mismatch();
            detail.records.forEach(record => validRecord(record, detail));
            const parent = $('careCycleDetails'), summary = detail.summary;
            parent.append(node('h3', `自助周期 #${detail.id} · ${detail.start_date} 至 ${detail.end_date}`));
            field(parent, '日历时区', detail.calendar_timezone);
            field(parent, '服务器统计截至日期', summary.as_of_date ?? detail.as_of_date);
            field(parent, '处理状态', statusLabels[detail.processing_status] ?? detail.processing_status);
            if (detail.suspension_reason) field(parent, '暂停原因', suspensionLabels[detail.suspension_reason] ?? detail.suspension_reason);
            field(parent, '服务器覆盖率', typeof summary.coverage === 'number' ? `${(summary.coverage * 100).toFixed(1)}%` : '尚无到期日（未知）');
            field(parent, '已记录 / 到期日', `${summary.completed_count} / ${summary.due_count}`);
            field(parent, '缺失日期', summary.missing_dates.length ? summary.missing_dates.join('、') : '无');
            detail.records.forEach(record => {
                const card = renderRecord(parent, record), button = node('button', '读取这一天的全部修订');
                button.type = 'button'; button.dataset.historyDate = record.record_date;
                button.addEventListener('click', () => readHistory(detail, record.record_date)); card.append(button);
            });
            selectedCycle = detail; message('已读取服务器周期统计与原件。');
        } catch (failure) { if (operation === cycleEpoch) error(failure, ticket); }
    }
    async function readHistory(cycle, date) {
        const ticket = epoch, operation = ++historyEpoch;
        $('careHistory').replaceChildren(); message('正在读取日期修订历史…');
        try {
            if (!current(ticket) || selectedCycle !== cycle) return;
            const records = list(await api.getDailyHistory(cycle.id, date));
            if (!current(ticket) || operation !== historyEpoch || selectedCycle !== cycle) return;
            records.forEach(record => validRecord(record, cycle, date));
            $('careHistory').append(node('h3', `${date} 的不可变修订历史`));
            records.forEach(record => renderRecord($('careHistory'), record));
            message('已读取全部服务器修订原件。');
        } catch (failure) { if (operation === historyEpoch) error(failure, ticket); }
    }
    async function load() {
        const ticket = ++epoch; clearViews(); message('正在读取当前获准资料…');
        try {
            if (!current(ticket)) return;
            if (doctor) {
                const payload = await api.getDoctorQueue();
                if (!current(ticket)) return;
                const items = list(payload); items.forEach(validAttention);
                attentionItems = items; renderAttention(items); $('careCoverage').textContent = coverage(payload.service_coverage);
            } else {
                if (!patientId) { message('请选择当前获准的本人或监护档案。'); return; }
                const [payload, cyclePayload] = await Promise.all([api.getPatientAttention(patientId), api.getCycles(patientId)]);
                if (!current(ticket)) return;
                const items = list(payload), cycleItems = list(cyclePayload);
                items.forEach(validAttention); cycleItems.forEach(cycle => validCycle(cycle));
                attentionItems = items; cycles = cycleItems;
                renderAttention(items); renderCycles(cycleItems); $('careCoverage').textContent = coverage(payload.service_coverage);
            }
            message('已读取当前获准资料。');
        } catch (failure) { error(failure, ticket); }
    }
    async function initialize() {
        try {
            if (!guard || !api || !session?.token || !id(session.accountId)
                || session.role !== (doctor ? 'researcher' : 'patient')) throw new Error('当前账号角色与本页不一致，请从对应账号重新打开。');
            guard.assertCurrentSession(session); guard.onInvalidated(stop);
            const context = await api.getContext();
            if (!current()) return;
            if (context.user_id != null && context.user_id !== session.accountId) mismatch();
            if (!doctor) {
                const patients = context.accessible_patients;
                if (!Array.isArray(patients) || patients.some(patient => !id(patient.patient_id))) mismatch();
                const selector = $('carePatient'); selector.replaceChildren(node('option', '请选择获准档案'));
                selector.options[0].value = '';
                patients.forEach(patient => {
                    const option = node('option', `${patient.display_name || '获准档案'} #${patient.patient_id}`);
                    option.value = patient.patient_id; selector.append(option);
                });
                const query = new URLSearchParams(location.search).get('patient_id');
                const selected = query === null ? session.patientId : /^\d+$/.test(query) ? Number(query) : null;
                if (patients.some(patient => patient.patient_id === selected)) patientId = selected;
                selector.value = patientId === null ? '' : String(patientId);
                selector.addEventListener('change', () => {
                    if (!current()) return;
                    const value = Number(selector.value);
                    patientId = patients.some(patient => patient.patient_id === value) ? value : null;
                    load();
                });
                if (!patientId) { message('请选择当前获准的本人或监护档案。'); return; }
            }
            await load();
        } catch (failure) { error(failure); }
    }
    $('careRefresh').addEventListener('click', load);
    window.addEventListener('pagehide', stop);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    initialize();
})();
