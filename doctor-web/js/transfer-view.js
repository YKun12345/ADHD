/* Read actual accepted responsibility under the page's fixed account and epoch. */
(() => {
    'use strict';
    const shell = document.getElementById('transferShell');
    if (!shell) return;
    const guard = window.SessionGuard, api = window.API?.Transfers, session = guard?.captureSession();
    const doctor = shell.dataset.role === 'doctor', $ = id => document.getElementById(id);
    const positive = value => Number.isSafeInteger(value) && value > 0;
    let stopped = false, epoch = 0, detailEpoch = 0, patientId = null;
    const status = { pending_acceptance:'等待接收医生接受', accepted:'接收医生已接受', rejected:'接收医生已拒绝', cancelled:'已撤销',
        open:'待查看', acknowledged:'已确认关注', resolved:'已解决', closed_with_reason:'已说明原因关闭', suspended:'已暂停',
        acknowledge:'确认关注', resolve:'标记已解决', close_with_reason:'说明原因关闭' };
    function node(tag, text, className) {
        const result = document.createElement(tag); if (text != null) result.textContent = String(text);
        if (className) result.className = className; return result;
    }
    const field = (parent, name, value) => parent.append(node('p', `${name}：${value ?? '待核对'}`));
    const time = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
        ? new Date(Date.parse(value) + 8*3600000).toISOString().slice(0,16).replace('T',' ')+'（北京时间）' : '待核对';
    function clear() { ['transferRequests','transferWork','transferDetail'].forEach(id => $(id).replaceChildren()); detailEpoch++; }
    function stop() { stopped = true; epoch++; clear(); $('transferPatient')?.replaceChildren(); patientId = null; $('transferRefresh').disabled = true; $('transferMessage').textContent = '页面已停止读取，请重新打开。'; }
    const current = ticket => !stopped && ticket === epoch && guard.isCurrentSession(session);
    function mismatch() { throw new Error('返回记录与实际档案或接收责任不一致。'); }
    function validSubject(row, responsibility) {
        if (!positive(row.id) || !positive(row.patient_id) || (doctor ? row[responsibility] !== session.accountId : row.patient_id !== patientId)) mismatch();
    }
    function fail(error, ticket) { if (current(ticket)) { clear(); $('transferMessage').textContent = error.message || '读取失败，请刷新重试。'; } }
    function button(parent, text, attribute, identifier, handler) {
        const result = node('button', text); result.type = 'button'; result.setAttribute(attribute, String(identifier));
        result.addEventListener('click', handler); parent.append(result);
    }
    async function showWork(row) {
        const ticket = epoch, operation = ++detailEpoch; $('transferDetail').replaceChildren();
        try {
            const [detail, history] = await Promise.all([api.getWork(row.id), api.history(row.id)]);
            if (!current(ticket) || operation !== detailEpoch) return;
            if (!detail.work || detail.work.id !== row.id || history.work_item_id !== row.id || !Array.isArray(history.items)) mismatch();
            validSubject(detail.work,'responsible_doctor_id');
            const parent = $('transferDetail'); parent.append(node('h3',`事项 ${row.id} 的原件和实际处理历史`));
            const original = detail.original_evidence;
            if (!original || original.attention_id !== row.original_attention_id) mismatch();
            field(parent,'原关注',original.attention_id); field(parent,'原负责医生账号',original.original_doctor_user_id);
            field(parent,'质量说明',(original.quality_reasons || []).map(value => value === 'execution_interrupted' ? '执行过程有中断' : value).join('；') || '无额外质量说明');
            if (original.evidence) {
                const disclosure = node('details'); disclosure.append(node('summary','展开本次明确选中原件'));
                disclosure.append(node('pre',JSON.stringify(original.evidence.client_evidence,null,2))); parent.append(disclosure);
            }
            if (!history.items.length) parent.append(node('p','尚无实际处理记录；查看不等于解决。'));
            history.items.forEach(item => {
                if (item.work_item_id !== row.id || item.patient_id !== row.patient_id || item.actor_user_id !== row.responsible_doctor_id) mismatch();
                field(parent,'实际处理',`账号 ${item.actor_user_id} · ${status[item.action] || item.action} · ${time(item.occurred_at)}`);
                if (item.reason) field(parent,'实际说明',item.reason);
            });
        } catch (error) { if (operation === detailEpoch) fail(error,ticket); }
    }
    async function load() {
        const ticket = ++epoch; clear(); $('transferMessage').textContent = '正在读取当前获准交接记录…';
        try {
            if (!current(ticket)) return;
            if (!doctor && !patientId) { $('transferMessage').textContent = '请选择获准档案。'; return; }
            const [requests, works] = await Promise.all([api.list(patientId),api.work(patientId)]);
            if (!current(ticket)) return;
            if (!Array.isArray(requests.items) || !Array.isArray(works.items)) mismatch();
            requests.items.forEach(item => {
                const request = item.request; validSubject(request,'receiver_doctor_user_id');
                if (!Array.isArray(request.sources)) mismatch();
                const card = node('article',null,'care-card'); card.append(node('h3',`交接 ${request.id} · ${status[item.status] || item.status}`));
                field(card,'接收医生账号',request.receiver_doctor_user_id); field(card,'实际提出时间',time(request.requested_at));
                field(card,'明确对象清单',request.sources.map(s => `${s.source_type === 'attention' ? '关注' : '继任事项'} ${s.source_id} · 原版本 ${s.expected_version}`).join('；'));
                if (request.reason) field(card,'用户实际说明',request.reason);
                button(card,'查看实际决定','data-transfer-id',request.id,async () => {
                    const operation = ++detailEpoch; $('transferDetail').replaceChildren();
                    try {
                        const detail = await api.get(request.id);
                        if (!current(ticket) || operation !== detailEpoch) return;
                        if (!detail.request || detail.request.id !== request.id) mismatch();
                        validSubject(detail.request,'receiver_doctor_user_id');
                        const parent = $('transferDetail'); parent.append(node('h3',`交接 ${request.id} · ${status[detail.status] || detail.status}`));
                        if (detail.decision) {
                            field(parent,'实际决定账号',detail.decision.actor_user_id); field(parent,'实际决定时间',time(detail.decision.decided_at));
                            if (detail.decision.reason) field(parent,'实际决定说明',detail.decision.reason);
                        } else parent.append(node('p','尚无实际接受决定，邀请或请求不表示责任已经转移。'));
                    } catch (error) { if (operation === detailEpoch) fail(error,ticket); }
                }); $('transferRequests').append(card);
            });
            works.items.forEach(row => {
                validSubject(row,'responsible_doctor_id'); if (row.original_provenance_preserved !== true) mismatch();
                const card = node('article',null,'care-card'); card.append(node('h3',`继任事项 ${row.id} · ${status[row.status] || row.status}`));
                field(card,'责任来源',`原关注 ${row.original_attention_id} · 原医生账号 ${row.from_doctor_user_id} → 实际负责医生账号 ${row.responsible_doctor_id}`);
                field(card,'实际接受时间',time(row.accepted_at)); field(card,'本事项原期望截止',row.expected_response_at ? time(row.expected_response_at) : '未配置');
                if (row.suspension_reason) field(card,'暂停原因',row.suspension_reason === 'responsibility_transferred' ? '已由下一位医生实际接受，原件保留' : '原接收授权或身份不可用；重新授权不会自动恢复');
                if (row.overdue_observation) { field(card,'本事项超时观察',time(row.overdue_observation.observed_at)); field(card,'机构现实流程',row.overdue_observation.institutional_instructions); field(card,'外部通知','未配置'); }
                button(card,'查看原件和实际处理历史','data-transfer-work-id',row.id,() => showWork(row)); $('transferWork').append(card);
            });
            if (!requests.items.length) $('transferRequests').append(node('p','当前没有可读取的交接请求。'));
            if (!works.items.length) $('transferWork').append(node('p','当前没有可读取的已接受继任事项。'));
            $('transferMessage').textContent = '已读取当前获准交接记录。';
        } catch (error) { fail(error,ticket); }
    }
    async function initialize() {
        try {
            if (!guard || !api || !session?.token || !positive(session.accountId) || session.role !== (doctor ? 'researcher' : 'patient')) throw new Error('请从当前对应账号重新进入。');
            guard.assertCurrentSession(session); guard.onInvalidated(stop);
            const context = await window.API.CareWorkflow.getContext(); if (!current(epoch)) return;
            if (context.user_id !== session.accountId) mismatch();
            if (!doctor) {
                const selector = $('transferPatient'), patients = context.accessible_patients;
                if (!Array.isArray(patients)) mismatch();
                patients.forEach(row => { if (!positive(row.patient_id)) mismatch(); const option = node('option',row.display_name || `获准档案 ${row.patient_id}`); option.value = row.patient_id; selector.append(option); });
                const query = new URLSearchParams(location.search).get('patient_id');
                const selected = query === null ? session.patientId : /^\d+$/.test(query) ? Number(query) : null;
                patientId = patients.some(row => row.patient_id === selected) ? selected : null; selector.value = patientId || '';
                selector.addEventListener('change',() => { if (!current(epoch)) return; const selected = Number(selector.value); patientId = patients.some(row => row.patient_id === selected) ? selected : null; load(); });
            }
            $('transferRefresh').addEventListener('click',() => { if (current(epoch)) load(); }); await load();
        } catch (error) { fail(error,epoch); }
    }
    window.addEventListener('pagehide',stop); document.addEventListener('visibilitychange',() => { if (document.hidden) stop(); });
    initialize();
})();
