(() => {
    'use strict';
    const {makePage,node,input,positive}=window.ClinicalBusiness,page=makePage('cycle',['patient']); if(!page)return;
    const query=new URLSearchParams(location.search),date=query.get('record_date'),nonce=query.get('xingzai_transfer');
    let transferred=false;
    page.reload=async()=>{const ticket=page.next(),view=page.area('clinicalInputs');view.replaceChildren();await page.pendingView();if(!page.current(ticket))return;
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('请先选择具体真实日期。');
        const detail=await page.request('/care/cycles/'+page.cycleId);if(!page.current(ticket))return;
        if(detail.id!==page.cycleId||detail.patient_id!==page.patientId||!Array.isArray(detail.records)||!detail.summary||date<detail.start_date||date>detail.end_date||date>detail.summary.as_of_date)throw Error('周期或实际记录日期不一致。');
        const prior=detail.records.find(row=>row.record_date===date),note=input('实际情况备注',true,500),dateField=input('记录日期',false,10,'date'); note.field.id='dailyNote';dateField.field.id='dailyDate';dateField.field.value=date;dateField.field.readOnly=true;
        if(prior&&(prior.patient_id!==page.patientId||prior.cycle_id!==page.cycleId||!positive(prior.revision)))throw Error('原日期记录版本不一致。');
        note.field.value=prior?.content.note||'';
        if(nonce&&!transferred){
            const binding={kind:'daily',patientId:page.patientId,cycleId:page.cycleId,date,revision:prior?.revision||0,contextDigest:prior?.content_digest||null,planVersionId:detail.plan_version_id??null};
            const content=window.parent!==window?window.parent.XingzaiHandoff?.take(nonce,binding,window,{accountId:page.session.accountId,role:page.session.role,patientId:page.patientId,revision:page.session.revision}):null;
            if(!content)throw Error('记录版本或会话已有变化，请返回聊天重新核对；尚未保存。');
            const merged=(note.field.value?note.field.value+'\n':'')+content.note;if(Array.from(merged).length>500)throw Error('合并备注超过500字，请返回聊天精简。');
            note.field.value=merged;transferred=true;
        }
        const form=node('form'),save=node('button','核对后保存该日期');save.id='dailySave';save.type='submit';save.disabled=page.pending||!(detail.allowed_actions||[]).includes('create_daily');
        form.append(dateField.wrapper,note.wrapper,node('p','修改备注会保留原日期其他字段和原报告时间；未记录的值保持未知。'),save);
        if(prior)form.append(node('p',`当前第 ${prior.revision} 版；专注时长：${prior.content.focus_minutes??'未记录'}。`));
        form.addEventListener('submit',event=>{event.preventDefault();if(Array.from(note.field.value).length>500)return;
            page.submit({label:'真实日期记录',idField:'client_submission_id',ackType:'daily_record',route:'/care/daily-records',queryRoute:'/care/daily-records/',
                payload:{client_submission_id:page.newId('daily'),patient_id:page.patientId,cycle_id:page.cycleId,record_date:date,expected_revision:prior?.revision||0,recorded_at:prior?.recorded_at??null,content:{...(prior?.content||{}),note:note.field.value}},
                confirm:`确认保存 ${date} 的实际情况？原有记录会保留修订历史。`});});view.append(form);page.say('已读取实际日期与当前版本，请核对后保存。');
    };page.run(page.reload);
})();
