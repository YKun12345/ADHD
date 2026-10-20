/* Scoped server history and actual-viewer receipts. Sending stays in the primary mini product. */
(() => {
    'use strict';
    const shell = document.getElementById('messageShell');
    if (!shell) return;
    const guard = window.SessionGuard, api = window.API?.CareSharedMessages;
    const session = guard?.captureSession(), doctor = shell.dataset.messageRole === 'doctor';
    const patientSelect = document.getElementById('messagePatient'), relationshipSelect = document.getElementById('messageRelationship');
    const itemsView = document.getElementById('messageItems'), statusView = document.getElementById('messageStatus'), refresh = document.getElementById('messageRefresh');
    const positive = value => Number.isSafeInteger(value) && value > 0;
    const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const instant = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
    let epoch = 0, stopped = false, busy = false, patientId = 0, relationshipId = 0, relations = [], messages = [];
    const mismatch = () => { throw new Error('资料来源或接收关系不一致，已隐藏内容，请重新读取。'); };
    const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = String(text); return element; };
    const current = ticket => !stopped && ticket === epoch && guard?.isCurrentSession(session);
    function controls(value) { updateCompose(); busy = value; patientSelect.disabled = value || stopped; relationshipSelect.disabled = value || stopped; refresh.disabled = value || stopped; }
    function clearMessages() { itemsView.replaceChildren(); messages = []; }
    const compose=node('a','核对具体接收关系并发送共享消息');compose.hidden=true;shell.prepend(compose);
    const updateCompose=()=>{compose.hidden=stopped||!positive(patientId)||!positive(relationshipId);compose.href=`${doctor?'doctor':'patient'}_message_compose.html?patient_id=${patientId}&relationship_id=${relationshipId}`;};
    function stop() {
        stopped = true; epoch++; clearMessages(); relations = []; patientId = 0; relationshipId = 0;
        patientSelect.replaceChildren(); relationshipSelect.replaceChildren(); controls(false);
        statusView.textContent = '本页已停止读取，请重新打开页面。';
    }
    function failure(error, ticket) {
        if (!current(ticket)) return;
        clearMessages(); controls(false); statusView.textContent = error?.message || '读取失败，请重新核对身份和共享关系。';
    }
    function options(select, rows, placeholder) {
        select.replaceChildren(); const first = node('option', placeholder); first.value = ''; select.append(first);
        rows.forEach(row => { const option = node('option', row.label); option.value = String(row.id); select.append(option); });
    }
    function validList(value) { if (!Array.isArray(value?.items)) mismatch(); return value.items; }
    function validateMessage(row, relation) {
        if (!positive(row.message_id) || row.patient_id !== patientId || row.relationship_id !== relation.relationship_id ||
            row.doctor_user_id !== relation.doctor_user_id || row.patient_actor_user_id !== relation.patient_actor_user_id ||
            !positive(row.relationship_revision) || !['patient', 'doctor'].includes(row.sender_kind) ||
            row.sender_user_id !== (row.sender_kind === 'doctor' ? row.doctor_user_id : row.patient_actor_user_id) ||
            typeof row.content !== 'string' || !row.content.trim() || row.content.length > 2000 || row.confirmed !== true || row.version !== 1 ||
            row.legacy !== false || row.submission_status !== 'committed' || !instant(row.sent_at) ||
            !digest(row.content_digest) || !digest(row.context_digest) || !digest(row.send_context_digest) || !Array.isArray(row.read_receipts)) mismatch();
        const viewers = new Set();
        row.read_receipts.forEach(receipt => {
            if (receipt.message_id !== row.message_id || !positive(receipt.viewer_user_id) || viewers.has(receipt.viewer_user_id) || !instant(receipt.read_at)) mismatch();
            viewers.add(receipt.viewer_user_id);
        });
        const own = row.read_receipts.find(receipt => receipt.viewer_user_id === session.accountId);
        if (row.viewer_read_at !== (own ? own.read_at : null)) mismatch();
    }
    function render() {
        itemsView.replaceChildren();
        if (!messages.length) { itemsView.append(node('p', '当前关系没有可读取的服务器消息。')); return; }
        messages.forEach(row => {
            const card = node('article'); card.className = 'care-card';
            card.append(node('h2', `${row.sender_kind === 'doctor' ? '医生' : '用户'}账号 ${row.sender_user_id}${row.sender_user_id === session.accountId ? '（我）' : ''}`));
            const content = node('p', row.content); content.style.whiteSpace = 'pre-wrap'; content.style.overflowWrap = 'anywhere'; card.append(content);
            card.append(node('p', `服务器发送时间（北京时间）：${new Date(Date.parse(row.sent_at) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')}`));
            card.append(node('p', row.viewer_read_at ? '我已查看' : '我尚未确认查看'));
            if (!row.viewer_read_at) {
                const button = node('button', '确认我已查看'); button.type = 'button'; button.dataset.messageRead = row.message_id;
                button.addEventListener('click', () => markRead(row.message_id)); card.append(button);
            }
            itemsView.append(card);
        });
    }
    async function readMessages(ticket) {
        const relation = relations.find(row => row.relationship_id === relationshipId);
        if (!relation) mismatch();
        const payload = await api.list(patientId, relationshipId);
        if (!current(ticket)) return false;
        const rows = validList(payload), ids = new Set();
        rows.forEach(row => { validateMessage(row, relation); if (ids.has(row.message_id)) mismatch(); ids.add(row.message_id); });
        messages = rows; render(); return true;
    }
    async function readRelationships(ticket) {
        relationshipId = 0; relations = []; clearMessages(); options(relationshipSelect, [], '请选择具体接收关系');
        if (!patientId) return;
        const payload = await api.relationships(patientId);
        if (!current(ticket)) return;
        const rows = validList(payload), ids = new Set();
        rows.forEach(row => {
            if (row.patient_id !== patientId || !positive(row.relationship_id) || ids.has(row.relationship_id) ||
                !positive(row.doctor_user_id) || !positive(row.patient_actor_user_id) || !positive(row.relationship_revision) ||
                !Array.isArray(row.scope) || !row.scope.includes('care') || typeof row.can_send !== 'boolean' ||
                (doctor && row.doctor_user_id !== session.accountId)) mismatch();
            ids.add(row.relationship_id);
        });
        relations = rows;
        options(relationshipSelect, rows.map(row => ({ id: row.relationship_id,
            label: `${doctor ? '用户账号 ' + row.patient_actor_user_id : '医生账号 ' + row.doctor_user_id} · 关系 ${row.relationship_id}${row.can_send ? '' : ' · 仅查看历史'}` })), '请选择具体接收关系');
        statusView.textContent = rows.length ? '已读取接收关系；请明确选择要查看的对方。' : '当前没有可读取的接收关系。';
    }
    async function load() {
        if (stopped || busy || !guard?.isCurrentSession(session)) return;
        const ticket = ++epoch; controls(true); clearMessages(); relations = []; relationshipId = 0;
        options(relationshipSelect, [], '请选择具体接收关系'); statusView.textContent = '正在核对获准档案…';
        try {
            if (!api || session.role !== (doctor ? 'researcher' : 'patient')) mismatch();
            const response = doctor ? await window.API.Doctor.getMyPatients() : await window.API.CareWorkflow.getContext();
            if (!current(ticket)) return;
            const patients = doctor ? validList(response) : response?.accessible_patients;
            if (!Array.isArray(patients) || patients.some(row => !positive(row.patient_id)) || new Set(patients.map(row => row.patient_id)).size !== patients.length) mismatch();
            const query = new URLSearchParams(location.search).get('patient_id');
            if (query !== null && !/^[1-9]\d*$/.test(query)) mismatch();
            const selected = patientId || (query ? Number(query) : !doctor && patients.length === 1 ? patients[0].patient_id : 0);
            if (selected && !patients.some(row => row.patient_id === selected)) mismatch();
            options(patientSelect, patients.map(row => ({ id: row.patient_id, label: `${row.patient_name || row.display_name || '获准档案'} · ${row.patient_id}` })), '请选择获准档案');
            patientId = selected; patientSelect.value = selected ? String(selected) : '';
            await readRelationships(ticket);
            if (current(ticket)) { controls(false); if (!patientId) statusView.textContent = '请先选择获准档案。'; }
        } catch (error) { failure(error, ticket); }
    }
    patientSelect.addEventListener('change', async () => {
        if (stopped || busy || !guard.isCurrentSession(session)) return;
        patientId = Number(patientSelect.value) || 0; const ticket = ++epoch; controls(true);
        try { await readRelationships(ticket); if (current(ticket)) controls(false); } catch (error) { failure(error, ticket); }
    });
    relationshipSelect.addEventListener('change', async () => {
        if (stopped || busy || !guard.isCurrentSession(session)) return;
        relationshipId = Number(relationshipSelect.value) || 0; const ticket = ++epoch; clearMessages();
        if (!relationshipId) return;
        controls(true); statusView.textContent = '正在读取当前关系的服务器消息…';
        try { await readMessages(ticket); if (current(ticket)) { controls(false); statusView.textContent = '已读取当前关系的服务器消息。'; } } catch (error) { failure(error, ticket); }
    });
    async function markRead(messageId) {
        if (stopped || busy || !guard.isCurrentSession(session) || !messages.some(row => row.message_id === messageId && !row.viewer_read_at)) return;
        const ticket = ++epoch; controls(true);
        try {
            const receipt = await api.markRead(messageId);
            if (!current(ticket)) return;
            if (receipt?.message_id !== messageId || receipt.viewer_user_id !== session.accountId || !instant(receipt.read_at)) mismatch();
            await readMessages(ticket);
            if (current(ticket)) { controls(false); statusView.textContent = '已记录当前账号查看；不代表专业处理或事项解决。'; }
        } catch (error) { failure(error, ticket); }
    }
    refresh.addEventListener('click', load);
    guard?.onInvalidated(stop);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    window.addEventListener('pagehide', stop);
    load();
})();
