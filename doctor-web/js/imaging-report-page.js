(() => {
    'use strict';
    const {makePage,node,input,button}=window.ClinicalBusiness,page=makePage('imaging',['patient','researcher']);if(!page)return;
    const pid=page.patientId,doctor=page.session.role==='researcher';
    async function review(row){return page.run(async()=>{const ticket=page.next(),ctx=await page.request(`/care/imaging-reports/publication-context?patient_id=${pid}&prediction_id=${row.prediction_id}`);if(!page.current(ticket))return;
        if(ctx.patient_id!==pid||ctx.actor_user_id!==page.session.accountId||ctx.prediction_id!==row.prediction_id)throw Error('影像审核来源不一致。');
        const form=node('form'),body=input('本人核对后的影像意见',true,8000),limitations=input('本版实际局限',true,4000);body.field.required=limitations.field.required=true;limitations.field.value=row.limitations;
        form.append(node('h2','明确发布新医生审核版本'),node('p',row.body),body.wrapper,limitations.wrapper);const send=node('button','确认发布审核版本');send.type='submit';form.append(send);
        form.addEventListener('submit',event=>{event.preventDefault();page.submit({label:'影像报告审核发布',idField:'client_publication_id',tokenField:'publication_context',contextField:'publication_context_digest',
            contextDigest:ctx.publication_context_digest,ackType:'imaging_report',route:'/care/imaging-reports',queryRoute:'/care/imaging-reports/submissions/',payload:{client_publication_id:page.newId('image-review'),patient_id:pid,
                prediction_id:row.prediction_id,expected_previous_version:ctx.expected_previous_version,input_digest:ctx.input_digest,publication_context:ctx.publication_context,body:body.field.value,limitations:limitations.field.value,confirmed:true},
            confirm:'确认核对本份实际分析的来源、用途与局限后发布新版本？原报告和演示标识保留。'});});page.area('clinicalInputs').replaceChildren(form);
    });}
    page.reload=async()=>{const ticket=page.next(),view=page.area('clinicalHistory');view.replaceChildren();page.area('clinicalInputs').replaceChildren();await page.pendingView();if(!page.current(ticket))return;
        const result=await page.request(`/care/imaging-reports?patient_id=${pid}`);if(!page.current(ticket))return;if(result.patient_id!==pid||!Array.isArray(result.items))throw Error('影像报告档案不一致。');
        for(const row of result.items){if(row.patient_id!==pid||row.status!=='published')throw Error('影像报告版本不一致。');const card=node('article');card.append(node('h2',`影像报告 ${row.id} · 第 ${row.version} 版`),
            node('p',row.publisher_kind==='doctor'?`医生审核版本 · 实际账号 ${row.actor_user_id}`:'系统分析，尚未经医生专业审核'),node('p',row.demonstration_only?'演示报告，不能用于诊断':'筛查辅助，不能代替诊断'),
            node('p',`实际分析 ${row.prediction_id} · ${row.source.model_name??'未记录'} / ${row.source.model_version??'未记录'}`),node('p',row.body),node('h3','本版局限'),node('p',row.limitations));
            if(doctor&&!page.pending)card.append(button('核对实际来源并审核',()=>review(row)));view.append(card);}
        page.say(result.items.length?'已读取实际影像报告版本。':'当前没有已生成的影像分析报告。');};page.run(page.reload);
})();
