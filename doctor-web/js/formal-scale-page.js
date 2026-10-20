(() => {
 'use strict';const{makePage,node,button,link,hash}=window.ClinicalBusiness,page=makePage('scale',['patient']);if(!page)return;
 const query=new URLSearchParams(location.search),itemId=Number(query.get('item_id')),pid=page.patientId,aid=page.assessmentId;let currentAttempt=null,answers=[],config=null;
 document.getElementById('clinicalNav').append(link('本轮评估','patient_assessments.html',{patient_id:pid,assessment_id:aid}));
 async function create(item){if(!confirm('确认由指定本人或实际主要监护人按近六个月实际情况填写？不知道的背景可跳过，答案不改量表回忆窗口。'))return;
  return page.run(async()=>{const ticket=page.next();currentAttempt=await page.request(`/care/assessment-items/${item.id}/attempts`,{expected_item_version:item.version,protocol_id:item.protocol_id,protocol_schema_version:item.protocol_schema_version,
   config_digest:item.config_digest,repeat_report_id:item.repeat_request?.report_id??null,performer_patient_id:null,respondent_kind:item.respondent_kind,confirmed:true,
   device:{platform:'web',device_type:'browser',viewport_width:innerWidth,viewport_height:innerHeight},input:{method:matchMedia('(pointer:coarse)').matches?'touch':'mouse'},timing:{clock_source:'performance.now',unit:'ms',calibrated:false},
   practice:{completed:false,attempts:0,exposure_count:0},assistance:{provided:false,kind:'none'},recall_window:item.recall_window});if(!page.current(ticket))return;query.set('attempt_id',currentAttempt.id);history.replaceState({},'',location.pathname+'?'+query);await page.reload();});}
 page.reload=async()=>{const ticket=page.next(),view=page.area('clinicalInputs'),record=page.area('clinicalHistory');view.replaceChildren();record.replaceChildren();await page.pendingView();if(!page.current(ticket))return;
  const session=await page.request(`/care/assessments/${aid}`);if(!page.current(ticket))return;if(session.id!==aid||session.patient_id!==pid||!Array.isArray(session.items))throw Error('评估与实际档案不一致。');
  const item=session.items.find(row=>row.id===itemId);if(!item||item.kind!=='scale'||item.patient_id!==pid)throw Error('具体量表项目与实际档案不一致。');
  view.append(node('h2',item.title),node('p','按近六个月实际情况填写。短周期再次填写不能单独解释为治疗改善。'));config=item.config;
  const attemptId=Number(query.get('attempt_id'));currentAttempt=item.attempts.find(row=>row.id===attemptId)||null;
  if(currentAttempt&&currentAttempt.execution_status==='submitted'){page.say('本次尝试已真实提交，原结果保留。');
   try{const ack=await page.request('/care/submissions/'+encodeURIComponent('web-'+currentAttempt.run_id));if(!page.current(ticket))return;const evidence=await page.request(`/care/submissions/${encodeURIComponent(ack.submission_id)}/evidence`);if(!page.current(ticket))return;
    if(evidence.context?.patient_id!==pid||evidence.context.attempt_id!==currentAttempt.id)throw Error('原结果归属不一致。');record.append(node('h2','服务器原始结果'),node('pre',JSON.stringify(evidence.server_result,null,2)));}catch(error){record.append(node('p','原始结果可从本轮正式报告中查看。'));}return;}
  if(!currentAttempt){if(!page.pending&&(item.allowed_actions||[]).includes('create_attempt'))view.append(button('确认实际填写人并开始新尝试',()=>create(item)));page.say('请先明确填写人，再创建本次量表尝试。');return;}
  if(currentAttempt.actor_user_id!==page.session.accountId||currentAttempt.submitter_user_id!==page.session.accountId||currentAttempt.assessment_id!==aid||currentAttempt.assessment_item_id!==itemId||currentAttempt.patient_id!==pid||
   currentAttempt.protocol_id!==item.protocol_id||currentAttempt.config_digest!==item.config_digest||currentAttempt.template_digest!==session.template_digest||currentAttempt.execution_status!=='in_progress')throw Error('原尝试、配置或实际填写身份不一致。');
  if(page.pending){page.say('本机已有正式提交原件，请按原编号恢复。');return;}
  if(!Array.isArray(config.questions)||!Array.isArray(config.options)||config.questions.length!==config.question_count&&config.question_count!=null)throw Error('冻结量表问题或选项不完整。');
  answers=Array(config.questions.length).fill(null);const form=node('form');
  config.questions.forEach((question,index)=>{const field=node('fieldset');field.append(node('legend',`${index+1}. ${typeof question==='string'?question:question.text}`));
   config.options.forEach((option,indexValue)=>{const value=typeof option==='object'?option.value:indexValue;if(!Number.isInteger(value)||value<0)throw Error('冻结量表选项分值无效。');const label=node('label'),radio=node('input');radio.type='radio';radio.name='q'+index;radio.value=value;radio.required=true;radio.addEventListener('change',()=>answers[index]=value);label.append(radio,node('span',typeof option==='string'?option:option.label));field.append(label);});form.append(field);});
  const send=node('button','明确确认并提交本次原始答案');send.type='submit';form.append(send);form.addEventListener('submit',async event=>{event.preventDefault();if(answers.some(v=>v===null))return;
   const p={submission_id:'web-'+currentAttempt.run_id,kind:'scale',patient_id:pid,assessment_id:aid,assessment_item_id:itemId,attempt_id:currentAttempt.id,run_id:currentAttempt.run_id,task_id:item.patient_task_id??null,
    content:{scale_type:item.instrument,answers:answers.slice(),recall_window:'P6M',content_digest:item.content_digest}};
   for(const key of ['protocol_id','protocol_schema_version','config_digest','template_digest','actor_user_id','performer_kind','performer_user_id','performer_patient_id','respondent_user_id','respondent_kind','submitter_user_id'])p[key]=currentAttempt[key];
   const context=Object.fromEntries(Object.entries(p).filter(([key])=>key!=='content'));
   page.submit({label:'本轮正式量表原始答案',idField:'submission_id',tokenField:null,contextField:null,contextDigest:await hash(context),ackType:'assessment_submission',route:'/care/submissions',queryRoute:'/care/submissions/',payload:p,
    confirm:'确认由本次实际填写人提交全部原始答案？保存后按服务器真实结果、质量和医生验收分别显示。'});});view.append(form);page.say('当前答案只属于这个真实尝试，提交前将可靠保存原件。');};page.run(page.reload);
})();
