(() => {
    'use strict';
    const shell = document.getElementById('reportShell'); if (!shell) return;
    const guard = window.SessionGuard, session = guard?.captureSession(), api = window.API?.CareReports;
    const $ = id => document.getElementById(id), query = new URLSearchParams(location.search);
    const positive = value => Number.isSafeInteger(value) && value > 0;
    const identifier = key => /^\d+$/.test(query.get(key) || '') ? Number(query.get(key)) : null;
    const patientId = identifier('patient_id'), assessmentId = identifier('assessment_id');
    const categories = { self_screening: '自助筛查', evidence_review: '证据审核', screening_opinion: '筛查意见', clinical_assessment: '临床评估', diagnosis: '诊断意见' };
    let stopped = false, epoch = 0, detailEpoch = 0;
    const current = ticket => !stopped && ticket === epoch && guard.isCurrentSession(session);
    function node(tag, text) { const result = document.createElement(tag); if (text != null) result.textContent = String(text); return result; }
    function clear() { $('reportList').replaceChildren(); $('reportDetail').replaceChildren(); detailEpoch++; }
    function stop() { stopped = true; epoch++; clear(); $('reportRefresh').disabled = true; $('reportMessage').textContent = '页面已停止读取，请重新打开。'; }
    function validate(row) {
        if (!row || !positive(row.id) || row.patient_id !== patientId || row.assessment_id !== assessmentId ||
            !positive(row.version) || row.status !== 'published' || row.submission_status !== 'committed' || !categories[row.category]) {
            throw new Error('返回报告与当前档案、评估或已发布版本不一致。');
        }
    }
    function field(parent, title, value) { parent.append(node('p', `${title}：${value ?? '待核对'}`)); }
    const time = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
        ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + '（北京时间）' : '待核对';
    async function show(row) {
        const ticket = epoch, operation = ++detailEpoch; $('reportDetail').replaceChildren();
        try {
            const report = await api.get(row.id); if (!current(ticket) || operation !== detailEpoch) return;
            validate(report); if (report.id !== row.id || report.version !== row.version) throw new Error('报告版本不一致，请刷新。');
            const parent = $('reportDetail'); parent.append(node('h2', `${categories[report.category]} · 第 ${report.version} 版`));
            if (report.category === 'self_screening') field(parent, '生成来源', '系统筛查，未经医生专业确认');
            else field(parent, '实际发布医生账号', report.actor_user_id);
            field(parent, '发布时间', time(report.published_at));
            if (report.demonstration_only) parent.append(node('p', '本报告仅为合成资料演示，不能用于正式临床评估。'));
            parent.append(node('h3', report.category === 'self_screening' ? '系统筛查结果' : '医生已发布意见')); const body = node('p', report.body); body.id = 'reportBody'; parent.append(body);
            parent.append(node('h3', '本版局限')); const limitations = node('p', report.limitations); limitations.id = 'reportLimitations'; parent.append(limitations);
            field(parent, '冻结输入摘要', report.input_digest);
            parent.append(node('p', report.source_ai_decision_id ? `医生引用本人已核对的助手草稿（决定 ${report.source_ai_decision_id}）；当前无获准模型证据。` : 'AI草稿未提供；当前无获准模型证据。'));
            const disclosure = node('details'); disclosure.append(node('summary', '查看本版冻结的系统结果与原始材料'));
            disclosure.append(node('pre', JSON.stringify(report.input_snapshot, null, 2))); parent.append(disclosure);
            $('reportMessage').textContent = '已读取原发布版本。';
        } catch (error) { if (current(ticket) && operation === detailEpoch) { $('reportDetail').replaceChildren(); $('reportMessage').textContent = error.message || '读取失败，请刷新。'; } }
    }
    async function load() {
        const ticket = ++epoch; clear(); $('reportMessage').textContent = '正在读取已发布报告…';
        try {
            const response = await api.list(assessmentId); if (!current(ticket)) return;
            if (!Array.isArray(response.items)) throw new Error('报告列表格式不一致。');
            response.items.forEach(row => { validate(row); const button = node('button', `${categories[row.category]} · 第 ${row.version} 版 · ${time(row.published_at)}`);
                button.type = 'button'; button.dataset.reportId = row.id; button.addEventListener('click', () => { if (current(ticket)) show(row); }); $('reportList').append(button); });
            $('reportMessage').textContent = response.items.length ? '请选择要读取的已发布版本。' : '本轮尚无已发布报告。';
        } catch (error) { if (current(ticket)) { clear(); $('reportMessage').textContent = error.message || '读取失败，请刷新。'; } }
    }
    window.addEventListener('pagehide', stop); document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    if (!guard || !api || !session?.token || !positive(session.accountId) || !positive(patientId) || !positive(assessmentId) || session.role !== shell.dataset.role) {
        stop(); $('reportMessage').textContent = '请从当前账号的评估详情重新进入。'; return;
    }
    guard.onInvalidated(stop); $('reportRefresh').addEventListener('click', () => { if (current(epoch)) load(); }); load();
})();
