/* Browser consistency checks. The server verifies signed authority on every write. */
((root,factory)=>{const value=factory();if(typeof module==='object'&&module.exports)module.exports=value;else root.AgentFlow=value;})(typeof window==='undefined'?globalThis:window,()=>{
    'use strict';
    const POLICY='Xingzai-selected-dialogue-1',CURRENT_POLICY='Xingzai-current-message-1';
    const positive=value=>Number.isSafeInteger(value)&&value>0,hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    const clone=value=>JSON.parse(JSON.stringify(value)),length=value=>Array.from(value).length;
    const sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])):value;
    const canonical=value=>JSON.stringify(sort(value));
    async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value))))).map(b=>b.toString(16).padStart(2,'0')).join('');}
    function decode(token,prefix='unified-agent-run-context'){
        try{const parts=token.split('.');if(parts.length!==4||parts[0]!==prefix||parts[1]!=='v1'||!hash(parts[3])||!/^[A-Za-z0-9_-]+$/.test(parts[2]))return null;
            return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[2].replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));}catch{return null;}
    }
    function contextChoices(runs,owner){return runs.filter(row=>row.actor_user_id===owner.accountId&&row.patient_id===owner.patientId&&row.intent==='question'&&row.status==='completed'&&
        typeof row.original_message==='string'&&typeof row.artifact?.body?.reply==='string'&&row.artifact.body.reply.trim()&&length(row.original_message)+length(row.artifact.body.reply)<=4000)
        .slice(-4).map(row=>({run_id:row.run_id,user_message:row.original_message,assistant_message:row.artifact.body.reply}));}
    function verifiedPreview(ctx,ids,runs,owner){
        const signed=decode(ctx.run_context),preview=ctx.conversation_preview,policy=ids.length?POLICY:CURRENT_POLICY;
        if(!signed||ctx.actor_user_id!==owner.accountId||ctx.patient_id!==owner.patientId||ctx.role!==owner.role||ctx.question_mode!=='smart'||
            signed.actor_user_id!==owner.accountId||signed.patient_id!==owner.patientId||signed.role!==owner.role||signed.question_mode!=='smart'||
            ctx.external_ai?.field_policy_version!==policy||signed.external_ai?.field_policy_version!==policy||ids.length>2||ids.some(id=>!positive(id))||new Set(ids).size!==ids.length||
            canonical(signed.conversation_preview??null)!==canonical(preview??null))throw Error('本次外发范围或实际身份已变化，请重新预览。');
        if(!ids.length){if(preview!=null)throw Error('本次未选择历史对话，请重新预览。');return null;}
        const choices=contextChoices(runs,owner);
        if(!preview||preview.policy_version!==POLICY||!hash(preview.digest)||!Array.isArray(preview.turns)||preview.turns.length!==ids.length||
            preview.turns.some((turn,i)=>turn.run_id!==ids[i]||!choices.some(row=>canonical(row)===canonical(turn)))||
            preview.turns.reduce((sum,row)=>sum+length(row.user_message)+length(row.assistant_message),0)>4000)throw Error('选中对话的全文或版本已变化，请重新选择。');
        return clone(preview);
    }
    function companionView(value,actions){if(!value||value.protocol!=='Xingzai-flow-1'||!hash(value.fingerprint)||typeof value.title!=='string'||typeof value.summary!=='string'||
        typeof value.observation_context!=='string'||!Array.isArray(value.updates)||value.updates.some(row=>!hash(row.id)||typeof row.text!=='string'))return null;
        return {...value,resume_action_id:positive(value.resume_action_id)&&actions.some(row=>row.id===value.resume_action_id)?value.resume_action_id:null};}
    function suggestedIntents(text,role){
        if(role==='researcher')for(const [kind,pattern,label]of[['review_questions',/(帮我|替我|准备|起草).{0,10}(补问|追问)/,'准备本轮补问建议'],['plan_draft',/(帮我|替我|准备|起草).{0,10}计划/,'准备本轮计划建议'],['reply_draft',/(帮我|替我|准备|起草).{0,10}(回复|答复)/,'准备本轮回复建议']])if(pattern.test(text))return[{kind,label}];
        if(/(告诉医生|发给医生|联系医生|反馈给医生)/.test(text)||role==='researcher'&&/(告诉用户|发给用户|联系用户|告诉患者|发给患者)/.test(text))return[{kind:'message',label:role==='researcher'?'整理后告诉用户':'整理后告诉医生'}];
        if(role==='patient'&&/(帮我|替我|我想|请).{0,8}(记录|记一下|记下来)/.test(text))return[{kind:'daily',label:'带入真实日期记录'}];return[];
    }
    const originalNote=text=>String(text||'').replace(/^(?:请)?(?:帮我|替我|我想)?(?:记录一下|记一下|记下来|记录)[：:，,\s]*/,'').trim();
    function createBridge(active,now=()=>Date.now()){
        let item=null;
        return{prepare(id,binding,content,target,owner){item={id,binding:clone(binding),content:clone(content),target,owner:clone(owner),expires:now()+120000};},clear(){item=null;},
            take(id,binding,target,owner){if(!active()||!item||item.expires<now()){item=null;return null;}
                if(item.id!==id||item.target!==target||canonical(item.owner)!==canonical(owner)||canonical(item.binding)!==canonical(binding))return null;
                const result=clone(item.content);item=null;return result;}};
    }
    async function matchesDailyAck(entry,ack){const p=entry?.payload,o=entry?.owner;if(!p||!o||!ack||!positive(ack.record_id)||ack.actor_user_id!==o.accountId||ack.patient_id!==o.patientId||ack.patient_id!==p.patient_id||
        ack.client_submission_id!==p.client_submission_id||ack.cycle_id!==p.cycle_id||ack.record_date!==p.record_date||ack.expected_revision!==p.expected_revision||ack.revision!==p.expected_revision+1||
        ack.legacy!==false||ack.submission_status!=='committed'||!ack.actor_identity_basis||!ack.authorization_snapshot||!hash(ack.content_digest)||
        (p.recorded_at===null?ack.recorded_at!==null:Date.parse(ack.recorded_at)!==Date.parse(p.recorded_at))||!ack.content||Object.entries(p.content).some(([key,value])=>canonical(ack.content[key])!==canonical(value))||
        Object.entries(ack.content).some(([key,value])=>!Object.hasOwn(p.content,key)&&value!==null))return false;
        return ack.content_digest===await digest({...p,recorded_at:ack.recorded_at,content:ack.content});}
    return{POLICY,CURRENT_POLICY,canonical,digest,decode,contextChoices,verifiedPreview,companionView,suggestedIntents,originalNote,createBridge,matchesDailyAck};
});
