(() => {
    'use strict';
    const {makePage,node,input,button,link}=window.ClinicalBusiness,page=makePage('questions',['patient']);if(!page)return;
    const {patientId,assessmentId}=page;
    document.getElementById('clinicalNav').append(link('本轮评估','patient_assessments.html',{patient_id:patientId,assessment_id:assessmentId}));
    async function answer(row){return page.run(async()=>{
        const ticket=page.next(),ctx=page.check(await page.request(`/care/clarifications/${row.id}/reply-context`));if(!page.current(ticket))return;
        if(ctx.question_id!==row.id||ctx.actor_user_id!==page.session.accountId)throw Error('补问来源不一致。');
        const view=page.area('clinicalInputs');view.replaceChildren(node('h2','针对实际问题作答'),node('p',row.question));
        const form=node('form'),status=node('select'),reply=input('实际答复',true,4000);
        for(const [value,title]of[['provided','提供实际情况'],['unknown','不知道'],['skipped','跳过']]){const option=node('option',title);option.value=value;status.append(option);}
        const update=()=>{reply.wrapper.hidden=status.value!=='provided';reply.field.required=status.value==='provided';if(status.value!=='provided')reply.field.value='';};status.addEventListener('change',update);update();
        form.append(status,reply.wrapper);const send=node('button','确认保存本次答复');send.type='submit';form.append(send);
        form.addEventListener('submit',event=>{event.preventDefault();page.submit({label:'具体补问答复',idField:'client_reply_id',tokenField:'reply_context',contextField:'reply_context_digest',contextDigest:ctx.reply_context_digest,
            route:'/care/clarification-replies',queryRoute:'/care/clarification-replies/submissions/',payload:{client_reply_id:page.newId('answer'),patient_id:patientId,assessment_id:assessmentId,question_id:row.id,
                expected_assessment_version:ctx.assessment_version,expected_previous_revision:ctx.expected_previous_revision,reply_context:ctx.reply_context,answer_status:status.value,
                answer:status.value==='provided'?reply.field.value:null,confirmed:true},confirm:'确认按实际情况保存本次答复？原背景和旧回复保留，不知道或跳过保持未知。'});});view.append(form);
    });}
    page.reload=async()=>{const ticket=page.next();page.area('clinicalInputs').replaceChildren();const history=page.area('clinicalHistory');history.replaceChildren();await page.pendingView();if(!page.current(ticket))return;
        const result=await page.request(`/care/assessments/${assessmentId}/clarifications`);if(!page.current(ticket))return;if(!Array.isArray(result.items))throw Error('具体补问列表不完整。');
        for(const row of result.items){page.check(row);const card=node('article');card.append(node('h2',`问题 ${row.id}`),node('p',row.question));
            for(const reply of row.replies||[]){page.check(reply);card.append(node('p',`第 ${reply.revision} 版 · ${reply.answer_status}`),node('p',reply.answer??'未提供，情况未知'));}
            if(!page.pending)card.append(button('按实际情况答复或修订',()=>answer(row)));history.append(card);}
        page.say(result.items.length?'已读取医生具体补问及原答复。':'当前没有具体补问。');};page.run(page.reload);
})();
