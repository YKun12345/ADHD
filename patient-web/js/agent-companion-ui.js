/* Conversation UI, explicit previews and private same-tab business handoffs. */
window.createAgentCompanionUI = function (host) {
    'use strict';
    const { $, node, api, doctor, session, owner, current, request, message } = host, flow = window.AgentFlow;
    let runs = [], selected = [], previewResolve = null, observer = null, latestCompanion = null, observed = '', observing = '', running = false, formEpoch = 0, seenFingerprint='',mainSeen=false;
    const seenUpdates=new Set();
    const modeLabel = node('label', '回答方式'), mode = node('select'); mode.id = 'agentQuestionMode';
    for (const [value, text] of [['local', '直接解答'], ['smart', '智能解答 · 逐次确认发送']]) { const option = node('option', text); option.value = value; mode.append(option); }
    modeLabel.append(mode); $('agentForm').insertBefore(modeLabel, $('agentInput').parentElement);
    const choices = node('fieldset'), legend = node('legend', '可选：带上最近对话（最多两轮）'); choices.id = 'agentContextChoices'; choices.hidden = true; choices.append(legend);
    modeLabel.after(choices);
    const preview = node('section'); preview.id = 'agentSmartPreview'; preview.hidden = true; preview.setAttribute('role', 'region'); preview.setAttribute('aria-label', '本次发送全文'); $('agentForm').after(preview);
    const companion = node('article'); companion.id = 'agentCompanion'; companion.className = 'care-card'; $('agentActions').parentElement.before(companion);
    const business = node('div'), options = node('section'), form = node('section'); business.id = 'agentBusinessChoices'; options.id = 'agentBusinessOptions'; form.id = 'agentBusinessForm'; $('agentInput').parentElement.after(business, options, form);
    const close = node('button', '返回聊天'); close.type = 'button'; close.id = 'agentBusinessClose'; close.hidden = true; form.after(close);
    const bridge = flow.createBridge(current);
    window.XingzaiHandoff = { take(id, binding, child, childOwner) { return bridge.take(id, binding, child, childOwner); } };
    function cancelPreview() { preview.hidden = true; preview.replaceChildren(); const resolve = previewResolve; previewResolve = null; resolve?.(false); }
    function clearForm() { formEpoch++; bridge.clear(); form.replaceChildren(); options.replaceChildren(); close.hidden = true; }
    close.addEventListener('click', () => { clearForm(); message('已返回聊天；只有在业务表单明确保存或发送的内容才会提交。'); });
    function contextChoices() {
        choices.replaceChildren(legend); const rows = flow.contextChoices(runs, owner()); selected = selected.filter(id => rows.some(row => row.run_id === id));
        for (const row of rows) { const label = node('label'), input = node('input'); input.type = 'checkbox'; input.checked = selected.includes(row.run_id);
            input.addEventListener('change', () => { cancelPreview(); if (input.checked && selected.length >= 2) { input.checked = false; message('一次最多选择两轮对话。'); return; } selected = input.checked ? [...selected, row.run_id].sort((a,b)=>a-b) : selected.filter(id=>id!==row.run_id); });
            label.append(input, node('span', row.user_message.slice(0, 70))); choices.append(label); }
    }
    function inputMode() { const question = $('agentIntent').value === 'question'; modeLabel.hidden = !question; choices.hidden = !question || mode.value !== 'smart'; cancelPreview(); }
    mode.addEventListener('change', inputMode); $('agentIntent').addEventListener('change', inputMode);
    async function previewRequest(ctx, text, ids) {
        const value = flow.verifiedPreview(ctx, ids, runs, owner()); preview.replaceChildren(node('h2', '确认本次发送给 DeepSeek 的文字'), node('p', '仅发送以下问题及你选中的对话；报告、病历和其他档案不会默认附带。'), node('h3', '这次的问题'), node('p', text));
        for (const turn of value?.turns || []) preview.append(node('h3', '选中对话'), node('p', '你：' + turn.user_message), node('p', '星仔：' + turn.assistant_message));
        const yes = node('button', '确认发送以上文字'), no = node('button', '取消'); yes.type = no.type = 'button'; yes.id = 'agentSmartConfirm'; no.id = 'agentSmartCancel';
        preview.append(yes, no); preview.hidden = false;
        return new Promise(resolve => { previewResolve = resolve; no.onclick = cancelPreview; yes.onclick = () => { if (!current()) { cancelPreview(); return; } previewResolve = null; preview.hidden = true; preview.replaceChildren(); resolve(true); }; });
    }
    async function observe() {
        const value = latestCompanion;
        if (!value || !current() || document.hidden || (value.updates.length && running) || observed === owner().patientId + ':' + value.fingerprint || observing === value.fingerprint) return;
        const fullyVisible=element=>{if(!element)return false;const box=element.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight&&box.left>=0&&box.right<=innerWidth&&box.width>0&&box.height>0;};
        if(seenFingerprint!==value.fingerprint){seenFingerprint=value.fingerprint;mainSeen=false;seenUpdates.clear();}
        if(fullyVisible(companion.querySelector('[data-companion-main]')))mainSeen=true;
        companion.querySelectorAll('[data-companion-update]').forEach(row=>{if(fullyVisible(row))seenUpdates.add(row.dataset.companionUpdate);});
        if(!mainSeen||value.updates.some(row=>!seenUpdates.has(row.id)))return;
        observing=value.fingerprint;
        try { const result = await api.observe({patient_id: owner().patientId, observation_context: value.observation_context});
            if (current() && latestCompanion === value && result.observed === true && result.fingerprint === value.fingerprint) { observed = owner().patientId + ':' + value.fingerprint; companion.dataset.observed = 'true'; }
        } catch (_) { /* No baseline advance is inferred from a lost response. */ }
        finally { if(observing===value.fingerprint)observing=''; }
    }
    function renderCompanion() { companion.replaceChildren(); observer?.disconnect(); if (!latestCompanion) return;
        const main=node('div');main.dataset.companionMain='true';main.append(node('h2','星仔陪你下一步'),node('p',latestCompanion.title),node('p',latestCompanion.summary));companion.append(main);observer?.observe(main);
        if(!running)for(const row of latestCompanion.updates){const text=node('p',row.text);text.dataset.companionUpdate=row.id;companion.append(text);observer?.observe(text);}
    }
    observer = new IntersectionObserver(() => observe(),{threshold:[0,1]});
    window.addEventListener('scroll',observe,{passive:true});window.addEventListener('resize',observe);
    async function mount(file, args, binding, content) {
        if (!current()) return; clearForm(); const ticket = formEpoch, iframe = node('iframe'); iframe.title = binding.kind === 'daily' ? '核对日期记录' : '核对共享消息'; iframe.style.cssText = 'width:100%;height:650px;border:1px solid #dce9e7;border-radius:12px';
        const nonce = crypto.randomUUID(); form.append(iframe); close.hidden = false; bridge.prepare(nonce, binding, content, iframe.contentWindow, owner());
        iframe.src = file + '?' + new URLSearchParams({...args, xingzai_transfer: nonce});
        iframe.addEventListener('load', () => { if (ticket !== formEpoch || !current()) { bridge.clear(); return; } message('请在下面核对真实业务表单，再明确保存或发送；聊天仍保留原话。'); });
    }
    async function businessOptions(kind, text) {
        if (!current() || host.locked()) return; clearForm(); const ticket = formEpoch, pid = owner().patientId;
        options.append(node('p', '正在核对实际业务…'));
        try {
            if (kind === 'message') {
                const result = await request('/care/shared-messages/relationships?patient_id=' + pid); if (!current() || ticket !== formEpoch) return;
                options.replaceChildren(); if (!Array.isArray(result.items)) throw Error('实际接收关系不可用。');
                for (const row of result.items.filter(row=>row.patient_id===pid&&row.can_send)) {
                    const choose = node('button', `核对关系 ${row.relationship_id} 并填写消息`); choose.type = 'button'; choose.onclick = async () => { if (!current()) return; try {
                        const fresh = await request('/care/shared-messages/relationships?patient_id=' + pid); if (!current() || ticket !== formEpoch) return;
                        const actual = fresh.items.find(item=>item.relationship_id===row.relationship_id&&item.patient_id===pid&&item.can_send);
                        if (!actual || actual.relationship_revision !== row.relationship_revision || actual.send_context_digest !== row.send_context_digest) throw Error('共享关系已有变化，请重新核对。');
                        await mount(doctor?'doctor_message_compose.html':'patient_message_compose.html', {patient_id:pid,relationship_id:row.relationship_id},
                            {kind:'message',patientId:pid,relationshipId:row.relationship_id,revision:row.relationship_revision,contextDigest:row.send_context_digest}, {content:text});
                    } catch(error) { if(current()) message(error.message); } }; options.append(choose);
                }
            } else if (kind === 'daily' && !doctor) {
                const result = await request('/care/cycles?patient_id=' + pid); if (!current() || ticket !== formEpoch) return; options.replaceChildren();
                if (!Array.isArray(result.items)) throw Error('真实日期周期不可用。');
                for (const row of result.items) {
                    if (row.patient_id !== pid || !(row.allowed_actions || []).includes('create_daily')) continue;
                    const date = node('input'); date.type = 'date'; date.min = row.start_date; date.max = row.end_date < result.as_of_date ? row.end_date : result.as_of_date; date.value = date.max;
                    if (date.value < date.min) continue;
                    const label = node('label', `周期 ${row.id} · 选择实际日期`); label.append(date); const choose = node('button', '核对该日期并带入备注'); choose.type = 'button';
                    choose.onclick = async () => { if (!current() || date.value < date.min || date.value > date.max) return; try {
                        const detail = await request('/care/cycles/' + row.id); if (!current() || ticket !== formEpoch) return;
                        if (detail.patient_id !== pid || detail.id !== row.id || !(detail.allowed_actions||[]).includes('create_daily')) throw Error('周期来源或处理权限已有变化。');
                        const prior = detail.records.find(record=>record.record_date===date.value), note = flow.originalNote(text);
                        if (Array.from((prior?.content.note ? prior.content.note+'\n' : '')+note).length > 500) throw Error('合并备注超过500字，请先精简；原话仍保留。');
                        await mount('patient_daily.html', {patient_id:pid,cycle_id:row.id,record_date:date.value},
                            {kind:'daily',patientId:pid,cycleId:row.id,date:date.value,revision:prior?.revision||0,contextDigest:prior?.content_digest||null,planVersionId:detail.plan_version_id??null}, {note});
                    } catch(error) { if(current()) message(error.message); } }; label.append(choose); options.append(label);
                }
            }
            if (!options.childElementCount) options.append(node('p', '当前没有可办理的关系或周期，请先在业务页面确认。'));
        } catch(error) { if(current() && ticket===formEpoch) { options.replaceChildren(); message(error.message); } }
    }
    function suggest() { business.replaceChildren(); if (!current() || $('agentIntent').value !== 'question') return;
        const text = $('agentInput').value; for (const row of flow.suggestedIntents(text, doctor?'researcher':'patient')) { const button=node('button',row.label); button.type='button'; button.onclick=()=> {
            if (!current() || host.locked()) return;
            if (['review_questions','plan_draft','reply_draft'].includes(row.kind)) { $('agentIntent').value=row.kind; $('agentIntent').dispatchEvent(new Event('change')); message('已选择专业建议，请确认本轮评估后点击准备；不会自动发布。'); }
            else businessOptions(row.kind,text);
        }; business.append(button); }
    }
    $('agentInput').addEventListener('input', () => { cancelPreview(); clearForm(); suggest(); });
    inputMode();
    return { mode:()=>mode.value, ids:()=>[...selected], previewRequest,
        controls(disabled) { mode.disabled=disabled; choices.querySelectorAll('input').forEach(input=>input.disabled=disabled); },
        history(rows,active) { runs=rows; running=active; contextChoices(); renderCompanion(); observe(); },
        actions(result) { latestCompanion=flow.companionView(result.companion,result.items); companion.replaceChildren(); delete companion.dataset.observed;
            renderCompanion(); observe(); },
        clear() { cancelPreview(); clearForm(); runs=[];selected=[];running=false;latestCompanion=null;seenFingerprint='';mainSeen=false;seenUpdates.clear();choices.replaceChildren(legend);business.replaceChildren();companion.replaceChildren();observer.disconnect();delete companion.dataset.observed; },
        stop() { this.clear(); observer.disconnect();window.removeEventListener('scroll',observe);window.removeEventListener('resize',observe); }
    };
};
