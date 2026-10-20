(() => {
    const guard = window.SessionGuard;
    const labels = { profile: '基础资料', assessment: '评估与报告', tracking: '记录', care: '任务和消息', imaging: '已有影像分析' };
    const purposes = { basic_use: '基本使用', clinical_sharing: '临床共享', external_ai: '外部AI', research: '具体研究' };
    const statuses = { pending: '待确认', active: '有效', confirmed:'监护人已确认', verified: '已核验', unverified: '未核验', revoked: '已撤回', withdrawn: '已撤回', expired: '已到期', suspended: '已暂停', rejected: '未通过', granted: '已同意', denied: '授权校验未通过', superseded: '已被后续同意替代', transferred: '已完成监护交接', adult_converted: '已转换为成人本人身份' };
    const scopeText = values => (values || []).map(key => labels[key] || key).join('、');
    const relationshipState = row => row.effective_status || (row.status === 'active' && row.effective_access === false ? 'denied' : row.status);
    const node = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    const expiry = () => new Date(Date.now() + 90 * 86400000).toISOString();

    function mount(root) {
        const session = guard.captureSession();
        const role = root.dataset.authorizationRole;
        const api = window.API.Authorization;
        let version = 0, busy = false;
        const status = node('p', '', 'authorization-status');
        status.setAttribute('role', 'status');
        const content = node('div');
        root.replaceChildren(node('h2', '身份与共享授权'), status, content);
        function current() { return guard.isCurrentSession(session) && root.isConnected; }
        function button(parent, text, action, marker) {
            const control = node('button', text);
            control.type = 'button'; control.disabled = busy;
            if (marker) control.dataset.authorizationAction = marker;
            control.addEventListener('click', action);
            parent.append(control);
            return control;
        }
        function section(title) { const part = node('section', undefined, 'authorization-section'); part.append(node('h3', title)); content.append(part); return part; }
        async function act(operation, confirmation, message) {
            if (busy || !current()) return;
            guard.assertCurrentSession(session);
            if (confirmation && !window.confirm(confirmation)) return;
            guard.assertCurrentSession(session);
            busy = true; status.textContent = '正在确认操作…';
            content.querySelectorAll('button').forEach(item => { item.disabled = true; });
            try {
                await operation(); guard.assertCurrentSession(session);
                if (!current()) return;
                busy = false;
                const ok = await reload();
                if (current()) status.textContent = ok ? message : '操作已确认，最新状态读取失败，请刷新核对。';
            } catch (error) {
                if (current()) status.textContent = error.message || '操作未获确认，请刷新后重试。';
            } finally {
                busy = false;
                if (current()) content.querySelectorAll('button').forEach(item => { item.disabled = false; });
            }
        }
        function render(context, relationships, consents, queue) {
            content.replaceChildren();
            if (context.demonstration_only) content.append(node('p', '当前连接测试环境，资料与正式账号分开保存。', 'authorization-note'));
            const identity = section('当前身份');
            if (role === 'researcher') identity.append(node('p', `医生资格：${statuses[context.doctor_qualification?.status] || '未核验'}。研究或审计身份不自动获得临床访问。`));
            for (const patient of context.accessible_patients || []) identity.append(node('p', `档案：${patient.display_name} · ${patient.access_kind === 'guardian' ? '监护访问' : '本人访问'}`));
            for (const guardian of context.guardian_relationships || []) {
                identity.append(node('p', `监护关系：${guardian.status === 'pending' ? '待本人确认' : ['verified','confirmed'].includes(guardian.status) && guardian.effective_access === false ? statuses.denied : statuses[guardian.status] || guardian.status}。`));
                if (guardian.status === 'pending') {
                    const age=node('input');age.type='number';age.min='18';age.max='120';age.value=guardian.guardian_age||'';age.setAttribute('aria-label','监护人实际年龄');identity.append(age);
                    button(identity,'确认我是主要监护人并开始使用',()=>{
                        const years=Number(age.value);if(!Number.isInteger(years)||years<18||years>120){status.textContent='请填写监护人实际年龄（18至120岁）';return;}
                        act(()=>api.guardianAction(guardian.id,'confirm-relationship',{expected_revision:guardian.revision,confirmed:true,guardian_age:years,declaration_version:'guardian-self-declaration-2026-10-19'}),
                            '我确认是该儿童的主要监护人，对所填资料负责，并确认注册时的基本使用同意；医生共享、AI和研究另行确认。','监护关系已确认。');
                    },'guardian-confirm');
                }
                identity.append(node('p', '资格变化后请重新登录以确认当前档案；历史账号和执行者保持原记录。', 'authorization-note'));
            }
            button(identity, '刷新授权状态', reload, 'refresh');
            const patient = (context.accessible_patients || [])[0];
            if (patient || (role === 'researcher' && context.doctor_qualification?.status === 'verified')) {
                const invitations = section('邀请共享');
                const form = node('form');
                const email = node('input'); email.type = 'email'; email.required = true;
                email.placeholder = role === 'patient' ? '医生注册邮箱' : '本人或监护人注册邮箱';
                email.setAttribute('aria-label', email.placeholder); email.dataset.authorizationInput = 'target-email';
                form.append(email);
                for (const [value, label] of Object.entries(labels)) {
                    const row = node('label', undefined, 'authorization-scope');
                    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.value = value; checkbox.checked = true; checkbox.name = 'scope';
                    row.append(checkbox, document.createTextNode(label)); form.append(row);
                }
                const submit = node('button', '发出邀请，等待确认'); submit.type = 'submit'; submit.dataset.authorizationAction = 'invite'; form.append(submit);
                form.addEventListener('submit', event => {
                    event.preventDefault();
                    const scope = Array.from(form.querySelectorAll('input[name="scope"]:checked'), item => item.value);
                    if (!scope.length) { status.textContent = '请至少选择一个共享范围。'; return; }
                    const data = { target_email: email.value.trim().toLowerCase(), scope, purpose: 'clinical_sharing', expires_at: expiry() };
                    if (patient) data.patient_id = patient.patient_id;
                    act(() => api.invite(data), `向 ${data.target_email} 邀请共享${scopeText(scope)}，有效期90天。双方确认后生效。`, '邀请已发出，等待对方确认。');
                });
                invitations.append(form);
            }
            const relationshipsPart = section('医患关系');
            if (!relationships.length) relationshipsPart.append(node('p', '暂无共享关系；旧邮箱绑定不能自动成为新共享。'));
            for (const row of relationships) {
                const card = node('div', undefined, 'authorization-row'); card.dataset.relationshipId = String(row.id);
                const subject = role === 'patient' ? (row.doctor_name || row.counterparty_email || '受邀医生') : (row.patient_name || `共享档案 #${row.patient_id}`);
                card.append(node('p', `${subject} · ${statuses[relationshipState(row)] || row.status}`),
                    node('p', `${scopeText(row.scope)} · ${row.expires_at || '期限以确认条款为准'}`, 'authorization-note'));
                if (row.effective_status !== 'denied' && row.status === 'pending' && row.initiator_user_id !== context.user_id) button(card, '确认共享范围',
                    () => act(() => api.accept(row.id, row.revision), `确认与 ${row.doctor_name || row.counterparty_email} 共享${scopeText(row.scope)}；期限${row.expires_at || '以服务端条款为准'}。可随时撤回。`, '共享关系已确认。'), 'accept');
                if (row.can_revoke === true || (row.can_revoke === undefined && row.effective_status !== 'denied' && ['pending', 'active'].includes(row.status))) button(card, '撤回共享',
                    () => act(() => api.revoke(row.id, row.revision), '撤回后停止此医生的后续共享访问与提交。本人历史结果保留，可继续自助或重新邀请医生。', '共享关系已撤回。'), 'revoke');
                relationshipsPart.append(card);
            }
            if (role === 'patient' && patient) {
                const part = section('用途同意');
                part.append(node('p', '基本使用、临床共享、外部AI和具体研究分别记录。拒绝AI或研究仍可做日常评估。', 'authorization-note'));
                for (const row of consents) {
                    const card = node('div', undefined, 'authorization-row'); card.dataset.consentId = String(row.id);
                    card.append(node('p', `${purposes[row.purpose] || row.purpose} · ${statuses[row.effective_status || row.status] || row.status} · 条款${row.terms_version}`));
                    if (row.project_id) card.append(node('p', `具体研究项目：${row.project_id}`));
                    if (row.effective_access !== false && ['active', 'granted'].includes(row.status)) button(card, '撤回此用途',
                        () => act(() => api.withdraw(row.id, row.revision), `撤回${purposes[row.purpose] || row.purpose}同意，停止此用途后续处理。已发布研究产物不能承诺即时消除；历史按保留规则处理。`, '用途同意已撤回。'), 'withdraw');
                    part.append(card);
                }
                if (!consents.some(row => row.purpose === 'basic_use' && ['active', 'granted'].includes(row.status) && row.effective_access !== false)) {
                    button(part, '以当前身份确认基本使用', () => act(() => api.grant({ patient_id: patient.patient_id, purpose: 'basic_use',
                        scope: Object.keys(labels), terms_version: 'W02-1' }),
                        '当前获准身份单独同意基本评估、记录和报告处理。医生共享、外部AI和具体研究分别确认；身份转换不继承原有同意。', '基本使用同意已确认。'), 'grant-basic');
                }
                button(part, '单独查看并确认外部AI用途', () => act(() => api.grant({ patient_id: patient.patient_id,
                    purpose: 'external_ai', scope: ['profile', 'assessment', 'tracking'], terms_version: 'W02-1', expires_at: expiry() }),
                    '允许外部AI在90天内处理最少必要的结构化评估与记录摘要；不含原始影像或默认分享私人聊天。可以撤回，拒绝仍可日常评估。', '外部AI用途已单独确认。'), 'grant-ai');
            }
            if (role === 'patient') renderIdentityConfirmation(context.pending_identity_confirmations || []);
            if ((context.identities || []).includes('institution_reviewer')) renderQueue(queue || []);
        }
        function renderIdentityConfirmation(confirmations) {
            const part = section('监护交接或成年本人接管');
            const details = node('details'); details.append(node('summary', '需要接管已有档案时填写'));
            details.append(node('p', '由原监护人提供关系编号和版本。新监护人或成年本人使用自己的账号确认，再由原监护人同意交接；用途同意需重新确认。', 'authorization-note'));
            const fields = {};
            for (const [name, label, type] of [['relationship', '原监护关系编号', 'number'], ['revision', '当前关系版本', 'number'], ['age', '本人年龄（18至120岁）', 'number'], ['proof', '交接说明，勿填证件全文', 'text']]) {
                const input = node('input'); input.type = type; input.required = true; input.placeholder = label;
                input.setAttribute('aria-label', label); input.dataset.authorizationInput = `identity-${name}`; details.append(input); fields[name] = input;
            }
            for (const [action, label] of [['confirm-transfer', '新监护人本人确认'], ['confirm-adult-conversion', '成年本人确认']]) button(details, label, () => {
                const id = Number(fields.relationship.value), revision = Number(fields.revision.value), age = Number(fields.age.value);
                if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(revision) || revision <= 0 || !Number.isInteger(age) || age < 18 || age > 120 || !fields.proof.value.trim()) {
                    status.textContent = '请核对关系编号、版本、本人年龄和核验引用。'; return;
                }
                act(() => api.guardianAction(id, action, { expected_revision: revision, proof_reference: fields.proof.value.trim(), terms_version: 'W02-1', age }),
                    '当前账号本人确认新的身份；仍需原监护人同意交接，并重新确认用途。', '本人确认已记录，等待原监护人同意。');
            }, action);
            part.append(details);
            for (const row of confirmations) part.append(node('p', `关系${row.relationship_id}，版本${row.revision}：${row.consumed ? '此确认已用于身份交接' : '本人已确认，等待原监护人同意'}。`, 'authorization-note'));
        }
        function renderQueue(queue) {
            const part = section('机构监护核验');
            part.append(node('p', '只使用机构核验引用。恢复、交接及成年转换需核验实际本人控制和新的用途同意，不能修改年龄直接获得权限。', 'authorization-note'));
            if (!queue.length) part.append(node('p', '当前机构没有待处理关系。'));
            for (const row of queue) {
                const card = node('div', undefined, 'authorization-row'); card.dataset.guardianId = String(row.id);
                card.append(node('p', `${row.patient_name} · 监护人${row.guardian_name} · ${statuses[row.status] || row.status}`), node('p', `关系证明：${row.proof_reference}`));
                const reference = node('input'); reference.placeholder = '本次机构核验引用'; reference.setAttribute('aria-label', reference.placeholder); reference.dataset.authorizationInput = 'review-reference'; card.append(reference);
                const action = (name, extra = {}) => {
                    if (!reference.value.trim()) { status.textContent = '请填写本次机构核验引用。'; return; }
                    act(() => api.guardianAction(row.id, name, { expected_revision: row.revision, review_reference: reference.value.trim(), ...extra }),
                        `确认关系${row.id}的${name === 'review' ? '核验' : name === 'suspend' ? '暂停' : '恢复'}，机构须已完成材料与实际身份核查。`, '监护关系状态已更新；相关账号须重新登录核对。');
                };
                if (row.status === 'pending') {
                    button(card, '机构核验通过', () => action('review', { status: 'verified', expires_at: expiry() }), 'guardian-review');
                    button(card, '核验未通过', () => action('review', { status: 'rejected' }), 'guardian-reject');
                }
                if (row.status === 'verified') button(card, '暂停监护访问', () => action('suspend'), 'guardian-suspend');
                if (['suspended', 'expired'].includes(row.status)) button(card, '核验后恢复', () => action('restore', { expires_at: expiry() }), 'guardian-restore');
                for (const confirmation of row.actual_actor_confirmations || []) {
                    if (!confirmation.confirmation_ready) continue;
                    const isTransfer = confirmation.purpose === 'transfer';
                    const proof = node('input'); proof.placeholder = isTransfer ? '与新监护人本人确认一致的证明引用' : '与成年本人确认一致的年龄';
                    proof.type = isTransfer ? 'text' : 'number'; proof.setAttribute('aria-label', proof.placeholder); card.append(proof);
                    button(card, `核验后${isTransfer ? '交接给新监护人' : '转换成年本人'}（账号${confirmation.user_id}）`, () => {
                        const value = proof.value.trim();
                        if (!reference.value.trim() || !value || (!isTransfer && (!Number.isInteger(Number(value)) || Number(value) < 18 || Number(value) > 120))) {
                            status.textContent = '请填写机构核验引用，并核对新账号确认的证明或年龄。'; return;
                        }
                        const data = { expected_revision: row.revision, review_reference: reference.value.trim(), expires_at: expiry(),
                            ...(isTransfer ? { new_guardian_user_id: confirmation.user_id, new_guardian_confirmed: true, proof_reference: value }
                                : { adult_user_id: confirmation.user_id, adult_confirmed: true, age: Number(value) }) };
                        act(() => api.guardianAction(row.id, isTransfer ? 'transfer' : 'adult-conversion', data),
                            '机构须已核验新账号本人控制和实际材料。原监护访问结束，历史执行者保持原记录，原用途同意不自动继承。', '身份转换已记录；相关账号须重新登录并分别确认新的用途。');
                    }, isTransfer ? 'guardian-transfer' : 'guardian-adult-conversion');
                }
                part.append(card);
            }
        }
        async function reload() {
            if (!current() || busy) return false;
            const latest = ++version;
            status.textContent = '正在读取授权状态…'; content.replaceChildren();
            try {
                const [context, response] = await Promise.all([api.getContext(), api.getRelationships()]);
                guard.assertCurrentSession(session);
                if (!current() || latest !== version) return false;
                const patient = (context.accessible_patients || [])[0];
                const [consents, queue] = await Promise.all([
                    role === 'patient' && patient ? api.getConsents(patient.patient_id) : { items: [] },
                    (context.identities || []).includes('institution_reviewer') ? api.getGuardianQueue() : { items: [] }
                ]);
                guard.assertCurrentSession(session);
                if (!current() || latest !== version) return false;
                render(context, response.items || [], consents.items || [], queue.items || []);
                status.textContent = ''; return true;
            } catch (error) {
                if (current() && latest === version) { content.replaceChildren(); status.textContent = error.message || '授权状态读取失败。'; button(content, '重新读取', reload); }
                return false;
            }
        }
        root.authorizationRefresh = reload;
        reload();
    }
    function initialize() {
        if (!guard.isCurrentSession(guard.captureSession())) return;
        document.querySelectorAll('[data-authorization-panel]').forEach(mount);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
    else initialize();
})();
