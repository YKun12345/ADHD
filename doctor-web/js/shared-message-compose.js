(() => {
    'use strict';
    const {makePage,node,input,button,hash,link,positive}=window.ClinicalBusiness,page=makePage('messages',['patient','researcher']);if(!page)return;
    const query=new URLSearchParams(location.search),pid=page.patientId,doctor=page.session.role==='researcher';
    document.getElementById('clinicalNav').append(link('已有共享消息',doctor?'doctor_messages.html':'patient_messages.html',{patient_id:pid}));
    page.reload=async()=>{const ticket=page.next(),view=page.area('clinicalInputs'),history=page.area('clinicalHistory');view.replaceChildren();history.replaceChildren();await page.pendingView();if(!page.current(ticket))return;
        const result=await page.request(`/care/shared-messages/relationships?patient_id=${pid}`);if(!page.current(ticket))return;if(!Array.isArray(result.items))throw Error('实际接收关系列表不完整。');
        const rows=result.items.filter(row=>row.patient_id===pid&&row.can_send);if(!rows.length){page.say('当前没有可发送的原临床关系，原消息可在历史页查看。');return;}
        const select=node('select');for(const row of rows){const option=node('option',`医生 ${row.doctor_user_id} / 用户或监护账号 ${row.patient_actor_user_id} · 关系 ${row.relationship_id}`);option.value=row.relationship_id;select.append(option);}
        if(rows.some(row=>String(row.relationship_id)===query.get('relationship_id')))select.value=query.get('relationship_id');
        const message=input('本人确认的共享内容',true,2000),form=node('form');message.field.required=true;let adopted=null;
        const nonce=query.get('xingzai_transfer');
        if(nonce&&!page._xingzaiTransferred){const row=rows.find(row=>String(row.relationship_id)===select.value),binding={kind:'message',patientId:pid,relationshipId:row.relationship_id,revision:row.relationship_revision,contextDigest:row.send_context_digest};
            const incoming=window.parent!==window?window.parent.XingzaiHandoff?.take(nonce,binding,window,{accountId:page.session.accountId,role:page.session.role,patientId:pid,revision:page.session.revision}):null;
            if(!incoming||typeof incoming.content!=='string'||Array.from(incoming.content).length>2000)throw Error('接收关系或会话已有变化，请返回聊天重新核对；尚未发送。');
            message.field.value=incoming.content;select.disabled=true;page._xingzaiTransferred=true;}
        if(positive(Number(query.get('ai_decision_id')))){adopted=await page.request(`/agent/artifact-decisions/${Number(query.get('ai_decision_id'))}/adoption-context`);if(!page.current(ticket))return;
            if(adopted.actor_user_id!==page.session.accountId||adopted.patient_id!==pid||adopted.target_type!=='shared_message')throw Error('草稿采纳与实际消息来源不一致。');message.field.value=adopted.content.text;message.field.readOnly=true;}
        form.append(node('h2','选择具体接收关系'),select,message.wrapper,node('p','确认后对方可见；私人助手历史不会随消息一起共享。'));
        const send=node('button','核对接收关系并明确发送');send.type='submit';send.disabled=page.pending;form.append(send);
        form.addEventListener('submit',event=>{event.preventDefault();const row=rows.find(row=>String(row.relationship_id)===select.value);if(!row)return;
            page.submit({label:'实际共享消息',idField:'client_message_id',tokenField:'send_context',contextField:'send_context_digest',contextDigest:row.send_context_digest,
                ackType:'shared_message',route:'/care/shared-messages',queryRoute:'/care/shared-messages/submissions/',payload:{client_message_id:adopted?.target_client_id||page.newId('message'),patient_id:pid,
                    relationship_id:row.relationship_id,send_context:row.send_context,content:message.field.value,source_ai_decision_id:adopted?.id??null,reply_to_message_id:null,confirmed:true},
                confirm:`确认将这份内容发送到医生 ${row.doctor_user_id} 与用户或监护账号 ${row.patient_actor_user_id} 的具体关系？`});});view.append(form);
        const read=async()=>{const row=rows.find(row=>String(row.relationship_id)===select.value),active=page.next();history.replaceChildren();
            const messages=await page.request(`/care/shared-messages?patient_id=${pid}&relationship_id=${row.relationship_id}`);if(!page.current(active))return;
            if(!Array.isArray(messages.items))throw Error('共享消息列表不完整。');for(const item of messages.items){if(item.patient_id!==pid||item.relationship_id!==row.relationship_id)throw Error('消息所属关系不一致。');const card=node('article');card.append(node('h3',`实际发送账号 ${item.sender_user_id}`),node('p',item.content));history.append(card);}};
        select.addEventListener('change',()=>page.run(read));await read();page.say('请核对当前具体接收关系和正文后明确发送。');};page.run(page.reload);
})();
