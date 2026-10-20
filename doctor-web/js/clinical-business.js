/* Shared doctor business transport and durable, owner-bound clinical originals. */
(() => {
    'use strict';
    const guard = window.SessionGuard, session = guard?.captureSession();
    const positive = value => Number.isSafeInteger(value) && value > 0;
    const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
    const canonical = value => JSON.stringify(sort(value));
    const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))))
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const node = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = String(text); return n; };
    const input = (label, multiline = false, max = 4000, type = 'text') => {
        const wrapper = node('label', label), field = node(multiline ? 'textarea' : 'input');
        field.setAttribute('aria-label', label); field.maxLength = max; if (!multiline) field.type = type;
        wrapper.append(field); return { wrapper, field };
    };
    const button = (text, action) => { const n = node('button', text); n.type = 'button'; n.addEventListener('click', action); return n; };
    const link = (text, file, args) => { const n = node('a', text); n.href = file + '?' + new URLSearchParams(args); n.style.marginRight = '18px'; return n; };
    const originalContext = token => {
        try { const body = token.split('.')[2].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body), c => c.charCodeAt(0)))); }
        catch (_) { throw new Error('原授权上下文无法核对，请重新读取。'); }
    };
    async function request(path, payload) {
        guard.assertCurrentSession(session);
        const response = await fetch(resolveApiBaseUrl() + path, { method: payload ? 'POST' : 'GET', credentials: 'include',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
            ...(payload ? { body: JSON.stringify(payload) } : {}) });
        const body = await response.json(); guard.assertCurrentSession(session);
        if (!response.ok) { const error = new Error(typeof body.detail === 'string' ? body.detail : '内容、权限或版本未通过，请重新核对。'); error.status = response.status; throw error; }
        return body;
    }
    // The nonextractable key and ciphertext stay in the same browser. No token is persisted here.
    let database;
    async function db() {
        if (database) return database;
        database = await new Promise((resolve, reject) => {
            const operation = indexedDB.open('smartbrain_clinical_originals_v1', 1);
            operation.onupgradeneeded = () => { operation.result.createObjectStore('keys'); operation.result.createObjectStore('originals', { keyPath: 'key' }); };
            operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error);
        }); return database;
    }
    async function stored(store, mode, operation) {
        const database = await db(); guard.assertCurrentSession(session);
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(store, mode), result = operation(transaction.objectStore(store));
            transaction.oncomplete = () => { try { guard.assertCurrentSession(session); resolve(result.result); } catch (error) { reject(error); } };
            transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || new Error('本机原件未能可靠保存。'));
        });
    }
    async function keyFor(owner) {
        const name = `${owner.accountId}:${owner.role}`;
        let key = await stored('keys', 'readonly', store => store.get(name));
        if (!key) {
            const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            // A concurrent tab may have saved the same owner key; one transaction chooses it.
            const database = await db(); key = await new Promise((resolve, reject) => {
                const tx = database.transaction('keys', 'readwrite'), store = tx.objectStore('keys'), get = store.get(name); let selected;
                get.onsuccess = () => { selected = get.result || candidate; if (!get.result) store.put(candidate, name); };
                tx.oncomplete = () => resolve(selected); tx.onerror = () => reject(tx.error);
            });
        } guard.assertCurrentSession(session); return key;
    }
    function makePage(mode, acceptedRoles = ['researcher']) {
        const shell = document.getElementById('clinicalShell'), message = document.getElementById('clinicalStatus'), query = new URLSearchParams(location.search);
        const id = name => /^[1-9]\d*$/.test(query.get(name) || '') ? Number(query.get(name)) : 0;
        const patientId = id('patient_id'), assessmentId = id('assessment_id'), cycleId = id('cycle_id');
        const scope = `${mode}:${patientId}:${assessmentId}:${cycleId}`, owner = { accountId: session?.accountId, role: session?.role, patientId, scope };
        const prefix = canonical(owner) + ':'; let stopped = false, busy = false, epoch = 0, pending = [];
        const current = ticket => !stopped && ticket === epoch && guard.isCurrentSession(session);
        const say = value => { if(!stopped&&guard.isCurrentSession(session))message.textContent = value; };
        const area = name => document.getElementById(name);
        function clear() { ['clinicalInputs', 'clinicalHistory', 'clinicalPending'].forEach(name => area(name).replaceChildren()); }
        function stop() { stopped = true; epoch++; pending = []; clear(); message.textContent='页面内容已清空，请重新打开或刷新后继续。'; }
        guard?.onInvalidated(stop); window.addEventListener('pagehide', stop);
        document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
        window.addEventListener('pageshow', event => { if (event.persisted && guard.isCurrentSession(session)) location.reload(); });
        async function originals() {
            const values = await stored('originals', 'readonly', store => store.getAll());
            const key = await keyFor(owner), result = [];
            for (const row of values.filter(value => value.key.startsWith(prefix) && !value.archived)) {
                const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv, additionalData: new TextEncoder().encode(row.key) }, key, row.cipher);
                const entry = JSON.parse(new TextDecoder().decode(decoded));
                if (canonical(entry.owner) !== canonical(owner) || row.key !== prefix + entry.id || await hash(entry.payload) !== entry.payloadDigest) throw new Error('本机原件完整性不一致，已停止提交。');
                result.push(entry);
            } return result;
        }
        async function save(entry) {
            const key = prefix + entry.id, iv = crypto.getRandomValues(new Uint8Array(12));
            if (await stored('originals', 'readonly', store => store.get(key))) throw new Error('这个原编号已存在，请按原编号查询。');
            const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(key) }, await keyFor(owner), new TextEncoder().encode(JSON.stringify(entry)));
            await stored('originals', 'readwrite', store => store.add({ key, iv, cipher, archived: false }));
        }
        async function sendOriginal(entry) {
            try { return await request(entry.route, entry.payload); }
            catch (error) {
                if ([403, 409, 422].includes(error.status)) {
                    // Only an actual write rejection enables F03 archival. A GET
                    // 404 or a lost response alone never releases the original.
                    entry.lastWriteRejection = error.status;
                    const name = prefix + entry.id, row = await stored('originals', 'readonly', store => store.get(name));
                    if (!row || row.archived) throw error;
                    const iv = crypto.getRandomValues(new Uint8Array(12));
                    const cipher = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(name)},await keyFor(owner),new TextEncoder().encode(JSON.stringify(entry)));
                    await stored('originals','readwrite',store=>store.put({...row,iv,cipher}));
                }
                throw error;
            }
        }
        async function match(entry, ack) {
            if (entry.ackType === 'daily_record') {
                if (!await window.AgentFlow.matchesDailyAck(entry, ack)) throw Error('日期记录确认与原账号、日期、版本或完整正文不同，原件仍保留。');
                await stored('originals', 'readwrite', store => store.delete(prefix + entry.id)); return ack;
            }
            const p = entry.payload;
            if(entry.ackType==='federated'){
                // Create endpoints return a resource; its original action is
                // always recovered from the same authenticated receipt endpoint.
                if(ack?.submission_status!=='committed')ack=await request(entry.queryRoute+encodeURIComponent(entry.id));
                if(typeof ack?.id!=='string'||!ack.id||ack.actor_user_id!==session.accountId||ack.client_request_id!==entry.id||
                    ack.submission_status!=='committed'||canonical(ack.original_request)!==canonical(p))throw new Error('研究操作确认与原账号、编号或内容不同，原件保留。');
                if(/^\/federated\/projects\/[1-9]\d*\/consent$/.test(entry.route)){
                    const r=ack.result;
                    if(!positive(r?.id)||r.patient_id!==p.patient_id||r.project_id!==p.project_id||r.project_revision!==p.expected_project_revision||
                        r.purpose!=='research'||r.status!=='active'||r.grantor_user_id!==session.accountId||r.terms_version!==p.terms_version||
                        canonical([...(r.scope||[])].sort())!==canonical([...p.scope].sort())||
                        (p.expires_at==null?r.expires_at!==null:Date.parse(r.expires_at)!==Date.parse(p.expires_at)))throw new Error('研究授权结果与原项目审批版本或范围不同，原件保留。');
                }
                await stored('originals','readwrite',store=>store.delete(prefix+entry.id));return ack;
            }
            if(entry.ackType==='assessment_submission'){
                const context=Object.fromEntries(Object.entries(p).filter(([key])=>key!=='content'));
                if(!ack||ack.submission_status!=='committed'||ack.submission_id!==entry.id||ack.patient_id!==patientId||ack.assessment_id!==assessmentId||ack.assessment_item_id!==p.assessment_item_id||
                    ack.attempt_id!==p.attempt_id||ack.run_id!==p.run_id||ack.task_id!==p.task_id||ack.result?.legacy!==false||ack.result?.kind!==p.kind||!positive(ack.result.id)||
                    ack.canonical_digest!==await hash({context,content:p.content}))throw new Error('正式提交确认与原始身份、尝试或答案不一致，原件仍保留。');
                await stored('originals','readwrite',store=>store.delete(prefix+entry.id));return ack;
            }
            const ctx = originalContext(p[entry.tokenField]);
            if (entry.ackType === 'imaging_report') {
                if (!positive(ack?.id) || ack.patient_id !== patientId || ack.actor_user_id !== session.accountId || ack.prediction_id !== p.prediction_id ||
                    ack.client_publication_id !== entry.id || ack.version !== p.expected_previous_version + 1 || ack.publisher_kind !== 'doctor' ||
                    ack.professional_review_status !== 'reviewed' || ack.status !== 'published' || ack.submission_status !== 'committed' || ack.legacy !== false || ack.confirmed !== true ||
                    ack.payload_digest !== entry.payloadDigest || ack.input_digest !== p.input_digest || ack.publication_context_digest !== entry.contextDigest ||
                    ack.body !== p.body || ack.limitations !== p.limitations || canonical(ack.original_request) !== canonical(p) ||
                    canonical(ack.authorization_snapshot) !== canonical(ctx.authorization_snapshot)) throw new Error('影像审核确认与本机原来源、版本或正文不一致，原件仍保留。');
                await stored('originals', 'readwrite', store => store.delete(prefix + entry.id)); return ack;
            }
            if (entry.ackType === 'shared_message') {
                if (!positive(ack?.message_id) || ack.sender_user_id !== session.accountId || ack.patient_id !== patientId || ack.client_message_id !== entry.id ||
                    ack.relationship_id !== ctx.relationship_id || ack.relationship_revision !== ctx.relationship_revision || ack.doctor_user_id !== ctx.doctor_user_id ||
                    ack.patient_actor_user_id !== ctx.patient_actor_user_id || ack.sender_identity_basis !== ctx.sender_identity_basis || ack.content !== p.content ||
                    ack.confirmed !== true || ack.submission_status !== 'committed' || ack.legacy !== false || ack.send_context_digest !== await hash(p.send_context) ||
                    canonical(ack.authorization_snapshot) !== canonical(ctx.authorization_snapshot) || canonical(ack.source_ai_decision_id ?? null) !== canonical(p.source_ai_decision_id ?? null) ||
                    canonical(ack.reply_to_message_id ?? null) !== canonical(p.reply_to_message_id ?? null)) throw new Error('消息确认与原发送者、关系或内容不同，原件仍保留。');
                await stored('originals', 'readwrite', store => store.delete(prefix + entry.id)); return ack;
            }
            if (!positive(ack?.id) || ack.patient_id !== patientId || ack.actor_user_id !== session.accountId || ack.actor_identity_basis !== ctx.actor_identity_basis ||
                ack.submission_status !== 'committed' || ack.legacy !== false || ack.confirmed !== true || ack.payload_digest !== entry.payloadDigest ||
                ack[entry.contextField] !== entry.contextDigest || canonical(ack.authorization_snapshot) !== canonical(ctx.authorization_snapshot)) throw new Error('服务器确认与本机原编号、内容或授权不同，原件仍保留。');
            const skip = new Set([entry.tokenField]);
            if (ack.original_request) {
                if (canonical(ack.original_request) !== canonical(p)) throw new Error('服务器原始请求内容不同，原件仍保留。');
            } else for (const [name, value] of Object.entries(p)) if (!skip.has(name) && canonical(ack[name]) !== canonical(value)) throw new Error('服务器确认内容不同，原件仍保留。');
            if (entry.expected && Object.entries(entry.expected).some(([name, value]) => canonical(ack[name]) !== canonical(value))) throw new Error('发布的正文或版本与确认草稿不同。');
            if (p.client_cycle_review_id && canonical(ack.original_request) !== canonical(p)) throw new Error('阶段决定原件不一致。');
            await stored('originals', 'readwrite', store => store.delete(prefix + entry.id)); return ack;
        }
        async function recover(entry) {
            return run(async ticket => {
                try { const ack = await request(entry.queryRoute + encodeURIComponent(entry.id)); await match(entry, ack); if(!current(ticket))return; say('已按原编号确认接收，未重复提交。'); await page.reload(); }
                catch (error) { if (error.status === 404) {
                    if(!current(ticket))return;
                    say('服务器尚无这个原编号；本机原件保留。可以明确重试同一份原件，或归档后重新核对资料。');
                    const parent = area('clinicalPending'); parent.append(button('确认按原编号和原内容重试', () => replay(entry)));
                    if ([403,409,422].includes(entry.lastWriteRejection)) parent.append(button('归档这份未接收原件', () => archive(entry)));
                } else throw error; }
            });
        }
        async function replay(entry) {
            if (!window.confirm('确认仅按这个原编号、原内容和原授权重试？如果材料或权限已变化，服务器会拒绝。')) return;
            return run(async ticket => { const ack = await sendOriginal(entry); await match(entry, ack); if(!current(ticket))return; say('原件已确认接收。'); await page.reload(); });
        }
        async function archive(entry) {
            if (!window.confirm('确认归档未接收原件并重新填写？归档原件会保留在本浏览器，且不再自动提交。')) return;
            return run(async ticket => {
                const original = (await originals()).find(row => row.id === entry.id);
                if (!original || ![403,409,422].includes(original.lastWriteRejection)) throw new Error('仅实际提交被403、409或422拒绝的原件可以归档；请继续按原编号查询。');
                try { const ack = await request(entry.queryRoute + encodeURIComponent(entry.id)); await match(entry, ack); say('查询发现原件已经接收。'); }
                catch (error) { if (error.status !== 404) throw error; const row = await stored('originals', 'readonly', store => store.get(prefix + entry.id)); row.archived = true; await stored('originals', 'readwrite', store => store.put(row)); say('未接收原件已归档。'); }
                if(current(ticket))await page.reload();
            });
        }
        async function pendingView() {
            const ticket=epoch, values=await originals(); if(!current(ticket))return false;
            pending = values; const view = area('clinicalPending'); view.replaceChildren();
            for (const entry of pending) { const card = node('article'), query=button('按原编号查询接收结果', () => recover(entry)); query.disabled=busy; card.append(node('p', `待确认原件：${entry.label} · ${entry.id}`), query); view.append(card); }
            return pending.length > 0;
        }
        async function run(operation) {
            if (busy || stopped || !guard.isCurrentSession(session)) return;
            busy = true; shell.setAttribute('aria-busy', 'true'); const disabled = new Map();
            const lock = () => shell.querySelectorAll('button').forEach(button => { if(!disabled.has(button)){disabled.set(button,button.disabled);button.disabled=true;} });
            const controlObserver = new MutationObserver(lock); controlObserver.observe(shell,{childList:true,subtree:true}); lock(); const ticket = epoch;
            try { await operation(ticket); }
            catch (error) { if (!stopped && guard.isCurrentSession(session)) { say(error.message || '操作未完成，请保留原件并重新读取。'); await pendingView().catch(() => {}); } }
            finally { busy = false; controlObserver.disconnect(); disabled.forEach((value,button)=>{if(button.isConnected)button.disabled=value;}); shell.removeAttribute('aria-busy');
                if(!stopped){area('clinicalPending').querySelectorAll('button').forEach(button=>button.disabled=false);if(pending.length)area('clinicalInputs').querySelectorAll('button[type="submit"]').forEach(button=>button.disabled=true);} }
        }
        async function submit(options) {
            if (busy || stopped || pending.length || !guard.isCurrentSession(session)) return;
            if (!window.confirm(options.confirm)) return;
            return run(async ticket => {
                const id = options.payload[options.idField], ctx = ['federated','daily_record'].includes(options.ackType)?{actor_user_id:session.accountId,patient_id:patientId,route:options.route,payload:options.payload}:options.ackType==='assessment_submission'?Object.fromEntries(Object.entries(options.payload).filter(([key])=>key!=='content')):originalContext(options.payload[options.tokenField]);
                if(['federated','daily_record'].includes(options.ackType))options.contextDigest=await hash(ctx);
                if ((options.ackType === 'shared_message' ? ctx.sender_user_id : ctx.actor_user_id) !== session.accountId || ctx.patient_id !== patientId || await hash(options.ackType === 'shared_message' ? options.payload[options.tokenField] : ctx) !== options.contextDigest) throw new Error('确认上下文与实际医生或档案不一致。');
                const entry = { schema: 1, id, owner, label: options.label, route: options.route, queryRoute: options.queryRoute,
                    tokenField: options.tokenField, contextField: options.contextField, contextDigest: options.contextDigest,
                    expected: options.expected || null, ackType: options.ackType || null, payload: options.payload, payloadDigest: await hash(options.payload) };
                await save(entry); if(!current(ticket))return; await pendingView(); if(!current(ticket))return; say('原件已可靠保存在本浏览器，正在提交…');
                const ack = await sendOriginal(entry); await match(entry, ack); say(options.success || '已确认接收。');
                if(current(ticket))await page.reload();
            });
        }
        const page = { patientId, assessmentId, cycleId, session, shell, area, say, current,
            async request(path,payload){const ticket=epoch;if(!current(ticket))throw Error('页面或会话已变化。');const result=await request(path,payload);if(!current(ticket))throw Error('页面或会话已变化。');return result;}, run, submit, pendingView,
            next: () => ++epoch, get pending() { return pending.length > 0; }, reload: async () => {}, newId: prefix => prefix + '-' + crypto.randomUUID(),
            check: row => { if (!row || row.patient_id !== patientId || (assessmentId && row.assessment_id !== assessmentId)) throw new Error('服务器材料与当前档案或评估不一致。'); return row; } };
        if (!guard || !session?.token || !acceptedRoles.includes(session.role) || mode!=='federated'&&!positive(patientId) || !['cycle','imaging','messages','artifact','followup','federated'].includes(mode) && !positive(assessmentId) || mode === 'cycle' && !positive(cycleId)) {
            stop(); say('请从当前账号的具体评估、计划或实际周期进入。'); return null;
        }
        area('clinicalRefresh').addEventListener('click', () => page.run(page.reload));
        return page;
    }
    window.ClinicalBusiness = { makePage, node, input, button, link, canonical, hash, positive };
})();
