(() => {
    'use strict';
    const shell=document.getElementById('agentShell'); if(!shell)return;
    const guard=window.SessionGuard, session=guard.captureSession(), api=window.API.Agent;
    const contract=window.AgentOriginal;
    const $=id=>document.getElementById(id), doctor=shell.dataset.agentRole==='doctor';
    const positive=value=>Number.isSafeInteger(value)&&value>0, query=new URLSearchParams(location.search);
    let pid=null, epoch=0, hidden=false, stopped=false, busy=false, pending=null, pendingKey=null, localBlocked=false, retryAllowed=false, timer=null, pollStarted=0;
    const current=ticket=>!stopped&&!hidden&&ticket===epoch&&guard.isCurrentSession(session);
    const node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=String(text);return n;};
    let experience=null, hasRunning=false, scopeBlocked=true;
    const profileLabels = { diagnosis_history:'既往评估情况', medication:'相关用药情况', other_conditions:'其他健康情况', sleep:'睡眠情况', school_work:'学习或工作情况' };
    const profileFields = {}, profilePanel = node('div'), cycleLabel = node('label','本次具体周期'), cycleSelect = node('select');
    cycleSelect.id='agentCycle'; cycleSelect.setAttribute('aria-label','本次具体周期'); cycleLabel.append(cycleSelect);
    for(const [value,label] of [['cycle_summary','实际周期摘要'],...(!doctor?[['profile_fields','逐项整理本人提供的背景']]:[])]) { const option=node('option',label);option.value=value;$('agentIntent').append(option); }
    if(!doctor)for(const [key,label] of Object.entries(profileLabels)) {
        const wrapper=node('label',label+'（选填）'),status=node('select'),text=node('textarea');text.maxLength=1000;text.hidden=true;text.setAttribute('aria-label',label);
        for(const [value,name] of [['skipped','跳过'],['unknown','不知道'],['provided','提供']]) {const option=node('option',name);option.value=value;status.append(option);}
        status.addEventListener('change',()=>{text.hidden=status.value!=='provided';if(text.hidden)text.value='';});wrapper.append(status,text);profilePanel.append(wrapper);profileFields[key]={status,text};
    }
    profilePanel.append(node('p','仅在本地逐字整理本次主动提供的内容；确认建议后还需在新建评估中逐项确认保存。'));
    $('agentForm').insertBefore(cycleLabel,$('agentInput').parentElement);$('agentForm').insertBefore(profilePanel,$('agentInput').parentElement);
    let profileAllowed=false;
    function inputMode(){const kind=$('agentIntent').value,profile=kind==='profile_fields';profilePanel.hidden=!profile;cycleLabel.hidden=kind!=='cycle_summary';
        $('agentInput').hidden=profile;$('agentInput').required=!profile;}
    $('agentIntent').addEventListener('change',inputMode);inputMode();
    const owner=()=>({accountId:session.accountId,role:session.role,patientId:pid,revision:session.revision});
    experience=window.createAgentCompanionUI({$,node,api,doctor,session,owner,current:()=>current(epoch),locked:()=>busy||scopeBlocked||Boolean(pending)||hasRunning,message,
        async request(path){if(!current(epoch))throw Error('页面或会话已有变化。');const response=await fetch(resolveApiBaseUrl()+path,{headers:{Authorization:'Bearer '+session.token}});const value=await response.json();if(!current(epoch))throw Error('页面或会话已有变化。');if(!response.ok)throw Error(typeof value.detail==='string'?value.detail:'业务读取未完成。');return value;}});
    const key=()=>`smartbrain_agent_pending_v1:${session.accountId}:${session.role}:${pid}:${session.revision}`;
    function controls(){ $('agentSend').disabled=busy||scopeBlocked||hasRunning||localBlocked||Boolean(pending)||!pid; $('agentProfile').disabled=busy;
        experience?.controls(busy||Boolean(pending)||hasRunning);
        $('agentAssessment').disabled=busy||Boolean(pending); $('agentIntent').disabled=busy||Boolean(pending);
        $('agentInput').disabled=busy||Boolean(pending); $('agentQuery').hidden=!pending;
        $('agentRetry').hidden=!pending||!retryAllowed; $('agentQuery').disabled=busy; $('agentRetry').disabled=busy;
        cycleSelect.disabled=busy||Boolean(pending);for(const field of Object.values(profileFields)){field.status.disabled=busy||Boolean(pending)||!profileAllowed;field.text.disabled=busy||Boolean(pending)||!profileAllowed;} }
    function message(text){$('agentMessage').textContent=text;}
    function clear(){clearTimeout(timer);timer=null;pending=null;pendingKey=null;localBlocked=false;retryAllowed=false;pollStarted=0;
        experience?.clear();hasRunning=false;scopeBlocked=true;
        $('agentHistory').replaceChildren();$('agentActions').replaceChildren();$('agentInput').value='';
        cycleSelect.replaceChildren();profileAllowed=false;for(const field of Object.values(profileFields)){field.status.value='skipped';field.text.value='';field.text.hidden=true;}}
    function readPending(){
        pending=null;pendingKey=null;retryAllowed=false;
        const name=Object.keys(localStorage).filter(name=>name===key()||name.startsWith(key()+':')).sort()[0];
        if(name){try{const value=JSON.parse(localStorage.getItem(name));if(value.schema!==1||contract.canonical(value.owner)!==contract.canonical(owner())||
            value.payload?.patient_id!==pid||!value.payload.client_run_id||!value.contextDigest)throw new Error('本机助手原件归属不一致，请保留原件。');pending=value;pendingKey=name;}
            catch(error){localBlocked=true;throw error;}}
        controls();
    }
    function persist(value){const raw=JSON.stringify(value),name=key()+':'+value.payload.client_run_id,previous=localStorage.getItem(name);
        if(previous!==null&&previous!==raw)throw new Error('原编号已有不同本机原件，请保留内容。');localStorage.setItem(name,raw);
        if(localStorage.getItem(name)!==raw){localBlocked=true;throw new Error('本机原件尚未保存，请保留输入内容。');}pending=value;pendingKey=name;controls();}
    function accepted(ack){if(!contract.matchesAck(pending,ack))throw new Error('助手确认与实际原编号、账号或输入不同，原件仍保留。');
        if(localStorage.getItem(pendingKey)!==JSON.stringify(pending))throw new Error('本机原件已变化，保留当前内容供核对。');
        localStorage.removeItem(pendingKey);readPending();message(pending?'本请求已接收，另有本机原件需要按编号查询。':'后台已接收，可继续其他业务。');}
    const statuses={queued:'后台等待处理',running:'正在核对资料',completed:'草稿已生成',failed:'生成未完成',stale:'原材料或权限已变化'};
    function validateRun(row){
        if(!row||row.actor_user_id!==session.accountId||row.patient_id!==pid||!positive(row.run_id)||!statuses[row.status])throw new Error('助手历史与当前档案归属不一致。');
        const a=row.artifact;if(a&&(a.actor_user_id!==session.accountId||a.patient_id!==pid||a.run_id!==row.run_id||a.status!=='draft'||!Array.isArray(a.source_refs)))throw new Error('草稿与实际运行来源不一致。');
    }
    async function history(ticket){
        const result=await api.runs(pid);if(!current(ticket))return false;
        if(result.actor_user_id!==session.accountId||result.patient_id!==pid||!Array.isArray(result.items))throw new Error('助手历史范围不一致。');
        result.items.forEach(validateRun);const list=$('agentHistory');list.replaceChildren();let active=false;
        for(const row of result.items.slice().reverse()){
            active||=['queued','running'].includes(row.status);
            const kind=row.intent||row.artifact?.kind||'question';
            const card=node('article');card.className='care-card';card.dataset.runId=row.run_id;
            card.append(node('h2',kind==='question'?'你和星仔的对话':`工作建议 · ${statuses[row.status]}`),node('p',kind==='profile_fields'?'请星仔逐项核对本次背景资料。':row.original_message));
            const a=row.artifact;if(a){card.append(node('p',kind==='question'?(row.question_mode==='smart'?(row.mode==='remote'?'智能解答 · 按本次确认范围':'本机解答 · 本次未使用外部模型'):'星仔解答'):a.body?.draft_method==='local_structured_rules'?'按本轮实际材料整理，待医生核对':row.mode==='remote'?'辅助工作建议，待人工核对':'按实际记录整理'));
                const reply=node('p',a.body?.reply||'');reply.className='agent-reply';card.append(reply);
                if(a.stale)card.append(node('p','该草稿的材料或权限已变化，请重新提问后再核对。'));
                const s=a.body?.summary;if(s&&kind!=='question')card.append(node('p',`实际提交 ${s.submitted_items} 项；有效 ${s.valid_submissions} 份，有局限 ${s.limited_submissions} 份；缺失 ${s.missing_items} 项。`));
                if(kind!=='question')for(const source of a.source_refs)card.append(node('p',`来源：${source}`));
                if(a.body?.plan_draft)card.append(node('p',a.body.plan_draft.instructions));
                for(const item of a.body?.questions||[])card.append(node('p',item.question));
                if(a.body?.reply_draft)card.append(node('p',a.body.reply_draft.text));
                if(kind!=='question'&&(kind!=='review_questions'||a.body?.questions?.length)&&(doctor||['profile_fields','cycle_summary'].includes(kind))){const edit=node('a','本人采纳、编辑或拒绝本建议');edit.href=(doctor?'doctor_draft.html':'../doctor-web/doctor_draft.html')+'?'+new URLSearchParams({patient_id:pid,artifact_id:a.id});card.append(edit);}
            }list.append(card);
        }
        hasRunning=active;experience.history(result.items,active);controls();
        clearTimeout(timer);
        if(active&&Date.now()-pollStarted<65000)timer=setTimeout(()=>{if(current(ticket))history(ticket).catch(error=>{if(current(ticket))message(error.message);});},1800);
        return true;
    }
    // These targets already have actual web readers. Other clinical operations
    // stay in their existing mini workflow until their web forms are connected.
    const targets=()=>doctor?{doctor_review:'doctor_review.html',doctor_plan:'doctor_plan.html',cycle_review:'doctor_cycle_review.html',care_cycles:'doctor_cycle_review.html',patient_plan:'doctor_plan.html',review_questions:'doctor_review.html',care_reports:'doctor_reports.html',care_attention:'doctor_care.html',assessments:'doctor_assessments.html',assessment_detail:'doctor_assessments.html'}:
        {review_questions:'patient_questions.html',patient_plan:'patient_plan.html',cycle_review:'patient_cycle_review.html',care_cycles:'patient_cycle_review.html',care_reports:'patient_reports.html',care_attention:'patient_care.html',assessments:'patient_assessments.html',assessment_detail:'patient_assessments.html'};
    async function actions(ticket){
        const result=await api.actions(pid);if(!current(ticket))return;
        if(result.patient_id!==pid||result.actor_user_id!==session.accountId||!Array.isArray(result.items))throw new Error('下一步来源不一致。');
        experience.actions(result);
        $('agentActions').replaceChildren();
        for(const item of result.items){if(!targets()[item.target?.page_key])continue;
            const button=node('button',item.title);button.type='button';button.addEventListener('click',async()=>{
                if(!current(ticket))return;button.disabled=true;
                try{const actual=await api.resolve(item.id,{patient_id:pid,expected_action_digest:item.action_digest});if(!current(ticket))return;
                    const target=actual.target,file=targets()[target?.page_key];
                    if(!file||actual.revalidated!==true||actual.patient_id!==pid||actual.action_digest!==item.action_digest||target.params?.patient_id!==pid||
                        Object.entries(target.params).some(([k,v])=>!['patient_id','assessment_id','cycle_id'].includes(k)||!positive(v)))throw new Error('下一步已变化，请刷新。');
                    location.assign(file+'?'+new URLSearchParams(target.params));
                }catch(error){if(current(ticket)){message(error.message);button.disabled=false;}}
            });$('agentActions').append(button);
        }
    }
    async function load(){
        if(stopped||hidden||busy||!pid)return;
        const ticket=++epoch;clear();busy=true;controls();message('正在读取当前获准资料…');
        try{readPending();const frame=await api.context(pid);if(!current(ticket))return;
            if(frame.patient_id!==pid||frame.actor_user_id!==session.accountId||frame.role!==session.role||!Array.isArray(frame.assessments))throw new Error('助手范围与当前账号不同。');
            const select=$('agentAssessment');select.replaceChildren();const all=node('option','全部获准评估（汇总）');all.value='';select.append(all);
            for(const row of frame.assessments){if(doctor&&row.responsible_doctor_id!==session.accountId)continue;const option=node('option',`第 ${row.id} 轮 · ${row.age_group==='child'?'儿童':'成人'}`);option.value=row.id;select.append(option);}
            const initial=query.get('assessment_id');
            if(initial!==null&&!frame.assessments.some(row=>positive(row.id)&&String(row.id)===initial&&(doctor?row.responsible_doctor_id===session.accountId:true)))throw Error('指定评估不在当前可用范围，请从本轮业务页重新进入。');
            if(initial!==null)select.value=initial;
            profileAllowed=(frame.authorized_scopes||[]).includes('profile');
            if((frame.cycles||[]).length!==1){const choose=node('option','请选择具体周期');choose.value='';cycleSelect.append(choose);}
            for(const row of frame.cycles||[]){const option=node('option',`${row.cycle_type==='professional'?'医生计划':'自助'}周期 ${row.id} · ${row.start_date} 至 ${row.end_date}`);option.value=row.id;cycleSelect.append(option);}
            const initialCycle=query.get('cycle_id');
            if(initialCycle!==null&&!(frame.cycles||[]).some(row=>positive(row.id)&&String(row.id)===initialCycle))throw Error('指定周期不在当前可用范围，请从日期记录页重新进入。');
            if(initialCycle!==null)cycleSelect.value=initialCycle;
            pollStarted=Date.now();await history(ticket);if(!current(ticket))return;await actions(ticket);if(!current(ticket))return;
            scopeBlocked=false;message(pending?'本机有待核对的原请求，请按原编号查询。':'仅使用当前获准资料。草稿不等于医生意见。');
            return true;
        }catch(error){if(current(ticket))message(error.message||'资料尚未读取成功。');}
        finally{if(current(ticket)){busy=false;controls();}}
    }
    async function send(event){event.preventDefault();if(busy||scopeBlocked||localBlocked||pending||!current(epoch))return;
        const intent=$('agentIntent').value,assessment=$('agentAssessment').value;
        if(intent==='profile_fields'&&!profileAllowed){message('当前未获背景处理权限，请先核对账号与隐私。');return;}
        const fields=Object.fromEntries(Object.entries(profileFields).map(([key,field])=>[key,{status:field.status.value,value:field.status.value==='provided'?field.text.value:null}]));
        const text=intent==='profile_fields'?JSON.stringify(fields):$('agentInput').value.trim();if(!text)return;
        if(text.length>4000){message('本次内容较长，请缩短至合计4000字内再整理。');return;}
        if(intent==='profile_fields'&&Object.values(fields).some(field=>field.status==='provided'&&!field.value.trim())){message('请选择提供项目的实际内容；也可以不知道或跳过。');return;}
        if(intent==='cycle_summary'&&!positive(Number(cycleSelect.value))){message('请先选择一个实际日期周期。');return;}
        if(doctor&&['review_questions','plan_draft','reply_draft'].includes(intent)&&!assessment){message('请先选择本人实际负责的评估。');return;}
        const ticket=++epoch;clearTimeout(timer);busy=true;controls();
        try{const mode=intent==='question'?experience.mode():null,ids=mode==='smart'?experience.ids():[];
            const ctx=await api.prepare(pid,mode,ids);if(!current(ticket))return;
            if(ctx.patient_id!==pid||ctx.actor_user_id!==session.accountId||ctx.role!==session.role)throw new Error('运行原授权范围不一致。');
            if(mode==='smart'&&!await experience.previewRequest(ctx,text,ids)){if(current(ticket))message('已取消，本次文字没有提交给模型。');return;}
            if(!current(ticket))return;
            persist({schema:1,owner:owner(),contextDigest:ctx.run_context_digest,payload:{client_run_id:'web-agent-'+crypto.randomUUID(),patient_id:pid,intent,
                assessment_id:intent==='profile_fields'?null:assessment?Number(assessment):null,cycle_id:intent==='cycle_summary'?Number(cycleSelect.value):null,message:text,expected_context_digest:ctx.input_digest,run_context:ctx.run_context,
                ...(mode==='smart'?{external_message_consent:{version:ids.length?window.AgentFlow.POLICY:window.AgentFlow.CURRENT_POLICY,confirmed:true},...(ids.length?{context_run_ids:ids}:{})}:{})}});
            const ack=await api.create(pending.payload);if(!current(ticket))return;accepted(ack);$('agentInput').value='';pollStarted=Date.now();await history(ticket);
        }catch(error){if(current(ticket))message(pending?'请求原件已保留，请按原编号查询后台是否接收。':error.message);}
        finally{if(current(ticket)){busy=false;controls();}}
    }
    async function recover(retry=false){if(busy||!pending||!current(epoch))return;const ticket=++epoch;clearTimeout(timer);busy=true;controls();
        try{let ack;
            if(retry){if(!retryAllowed||!window.confirm('确认按原编号、原内容和原授权重试？'))return;ack=await api.create(pending.payload);}
            else ack=await api.original(pending.payload.client_run_id);
            if(!current(ticket))return;accepted(ack);$('agentInput').value='';pollStarted=Date.now();await history(ticket);
        }catch(error){if(current(ticket)){retryAllowed=error.status===404;message(retryAllowed?'后台尚无此原编号，可明确确认后重试原件。':error.message||'原件仍保留。');}}
        finally{if(current(ticket)){busy=false;controls();}}
    }
    async function start(){
        if(stopped||hidden)return;
        const ticket=++epoch;busy=true;controls();
        try{if(session.role!==(doctor?'researcher':'patient'))throw new Error('请使用对应账号重新打开助手。');
            const result=await api.profiles(doctor);if(!current(ticket))return;
            const rows=doctor?result.items:result.accessible_patients;if(!Array.isArray(rows))throw new Error('获准档案列表不完整。');
            const profiles=$('agentProfile');profiles.replaceChildren();if(rows.length>1){const choose=node('option','请选择当前档案');choose.value='';profiles.append(choose);}for(const row of rows){if(!positive(row.patient_id))continue;
                const option=node('option',row.display_name||row.patient_name||`获准档案 ${row.patient_id}`);option.value=row.patient_id;profiles.append(option);}
            const initial=query.get('patient_id');
            if(initial!==null&&!rows.some(row=>String(row.patient_id)===initial&&positive(row.patient_id))){pid=null;profiles.value='';throw Error('指定档案不在当前账号的实际授权范围，请从业务页重新进入。');}
            if(initial!==null)profiles.value=initial;
            pid=Number(profiles.value)||null;busy=false;controls();if(!pid){message('请先确认本人、监护或临床共享关系。');return;}const loaded=await load();
            if(loaded&&current(epoch)&&!pending)$('agentInput').value=(query.get('prompt')||'').slice(0,2000);
        }catch(error){if(current(ticket)){message(error.message);busy=false;controls();}}
    }
    $('agentForm').addEventListener('submit',send);$('agentRefresh').addEventListener('click',load);
    $('agentQuery').addEventListener('click',()=>recover());$('agentRetry').addEventListener('click',()=>recover(true));
    $('agentProfile').addEventListener('change',()=>{if(busy)return;++epoch;clear();pid=Number($('agentProfile').value)||null;query.delete('assessment_id');query.delete('cycle_id');load();});
    $('agentAssessment').addEventListener('change',()=>{$('agentInput').value='';});
    function hide(){hidden=true;++epoch;busy=false;clear();$('agentAssessment').replaceChildren();$('agentProfile').replaceChildren();message('页面已隐藏，内容已清空。');controls();}
    document.addEventListener('visibilitychange',()=>{if(document.hidden)hide();else if(!stopped){hidden=false;start();}});
    window.addEventListener('pagehide',hide);window.addEventListener('pageshow',event=>{if(event.persisted&&!stopped){hidden=false;start();}});
    guard.onInvalidated(()=>{stopped=true;hide();experience.stop();});start();
})();
