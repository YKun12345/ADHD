(() => {
 'use strict';const{makePage,node,link}=window.ClinicalBusiness,page=makePage('followup',['patient','researcher']);if(!page)return;
 const pid=page.patientId,role=page.session.role==='researcher'?'doctor':'patient';
 document.getElementById('clinicalNav').append(link('本档案评估',role+'_assessments.html',{patient_id:pid}),link('沟通与任务',role+'_care.html',{patient_id:pid}));
 const sourceLink=(text,kind,id)=>link(text,kind==='cycle'?role+'_care.html':role+'_assessments.html',{patient_id:pid,[kind==='cycle'?'cycle_id':'assessment_id']:id});
 page.reload=async()=>{const ticket=page.next(),main=page.area('clinicalInputs'),history=page.area('clinicalHistory');main.replaceChildren();history.replaceChildren();
  const raw=await page.request('/care/followup-summary?patient_id='+pid);if(!page.current(ticket))return;
  const summary=window.FollowupDisplay.buildFollowupDisplay(raw,pid);main.append(node('h2','截至 '+summary.asOfDate),node('p',summary.coverageText));
  if(summary.truncatedText)main.append(node('p',summary.truncatedText));
  for(const row of summary.cycles){const card=node('article');card.append(node('h3',row.title),node('p',row.stateText+' · '+row.coverageText),node('p',row.metricsText),node('p',row.limitationsText),sourceLink('核对本周期原始记录','cycle',row.cycle_id));if(row.plan_version_id)card.append(node('p','实际计划版本 '+row.plan_version_id));main.append(card);}
  for(const row of summary.measurements){const card=node('article');card.append(node('h3',row.label),node('p',row.valueText),node('p',row.sourceText),sourceLink('核对本轮评估原件','assessment',row.assessment_id));main.append(card);}
  for(const row of summary.comparisons){if(row.patient_id!==pid||row.left.patient_id!==pid||row.right.patient_id!==pid||row.treatment_effect_conclusion_allowed!==false)throw Error('比较来源与当前档案不一致。');
   const card=node('article');card.append(node('h3',row.label+' · '+row.status_label),node('p',row.reasonText),node('p',row.interpretation));history.append(card);}
  for(const row of summary.events){const card=node('article');card.append(node('h3',row.record_date+' · 原始自报'),node('p',row.text),node('p',`实际周期 ${row.cycle_id} · 原记录 ${row.record_id} · 修订 ${row.revision}`),sourceLink('核对事件当日记录','cycle',row.cycle_id));history.append(card);}
  history.append(node('h2','下一步'));
  for(const row of summary.nextSteps){const target=row.target;if(target?.patient_id!==pid||!Number.isSafeInteger(target.cycle_id)||target.cycle_id<=0||!['care-cycles','cycle-review'].includes(target.page))throw Error('下一步不属于当前实际周期。');
   history.append(link(row.label,target.page==='cycle-review'?role+'_cycle_review.html':role+'_care.html',{patient_id:pid,cycle_id:target.cycle_id}));}
  if(!summary.nextSteps.length)history.append(node('p','暂无需要处理的下一步。'));history.append(node('h2','资料局限'));for(const text of summary.limitations)history.append(node('p',text));
  page.say('已读取当前授权范围的实际资料。资料差异需结合原始来源核对。');
 };page.run(page.reload);
})();
