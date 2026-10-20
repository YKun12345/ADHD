/* Full frozen tasks. Only actual UI actions and real deadlines create evidence. */
(() => {
 'use strict';
 const {makePage,node,button,link,hash,canonical}=window.ClinicalBusiness;
 const page=makePage('cognitive',['patient']);if(!page)return;
 const modules=window.FrozenCognitive,query=new URLSearchParams(location.search);
 const pid=page.patientId,aid=page.assessmentId,itemId=Number(query.get('item_id'));
 const names={reaction:'反应抑制任务',stroop:'颜色干扰任务',flanker:'箭头抗干扰任务',nback:'两步位置记忆任务',trail:'连线测试',digit:'数字广度测试'};
 const instructions={
  reaction:'绿色“点击”出现时尽快点击测试区域，红色“停”时不要点击。白色等待阶段提前点击会记为误触。',
  stroop:'忽略文字含义，只判断文字实际显示的颜色，选择对应颜色按钮。',
  flanker:'只判断中间箭头向左还是向右，两侧箭头或菱形都是干扰。',
  nback:'前两次点击黄色方格并记住位置。从第三次起判断绿色方格是否与两次之前的位置相同。每次由你的操作推进，没有自动超时跳题。',
  trail:'A阶段按1、2、3…顺序点击。B阶段按1、A、2、B…交替点击。点错后继续寻找当前目标。',
  digit:'先看数字逐个出现，消失后再输入。顺背按原顺序，倒背按相反顺序。同一长度两轮未答对会结束该方向。'
 };
 let engine=null,attempt=null,completed=null;
 document.getElementById('clinicalNav').append(link('返回本轮评估','patient_assessments.html',{patient_id:pid,assessment_id:aid}));
 const marker=a=>`smartbrain_cognitive_started_v1:${page.session.accountId}:${pid}:${a.id}`;
 function halt(){engine?.stop();engine=null;completed=null;attempt=null;}
 window.SessionGuard.onInvalidated(halt);window.addEventListener('pagehide',halt);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)halt();});
 window.addEventListener('resize',()=>{if(engine?.running){engine.stop();completed=null;page.say('显示区域已变化，本次执行已中断。请返回本轮评估创建新尝试。');page.area('clinicalInputs').replaceChildren();}});

 class Executor {
  constructor(task,config,view,alive,input,done){Object.assign(this,{task,config,view,alive,input,done});this.timers=new Set();this.records=[];this.stages=[];this.running=true;this.phase='';this.practice=false;}
  stop(){this.running=false;this.timers.forEach(clearTimeout);this.timers.clear();this.records=[];this.stages=[];}
  clearTimers(){this.timers.forEach(clearTimeout);this.timers.clear();}
  later(fn,ms){const id=setTimeout(()=>{this.timers.delete(id);if(this.running&&this.alive())fn();},ms);this.timers.add(id);}
  live(){return this.running&&this.alive();}
  action(text,fn){const b=button(text,event=>{if(!this.live())return;
   if(this.input==='keyboard'&&event.detail!==0)return;
   if(this.input!=='keyboard'&&event.detail===0)return;
   if(this.input==='touch'&&event.pointerType&&event.pointerType!=='touch')return;
   if(this.input==='mouse'&&event.pointerType&&event.pointerType!=='mouse')return;
   fn();});return b;}
  screen(phase,text){this.phase=phase;this.view.dataset.phase=phase;this.view.dataset.task=this.task;this.view.dataset.practice=String(this.practice);this.view.replaceChildren(node('p',(this.practice?'练习':'正式测试')+' · '+text));}
  begin(practice){this.clearTimers();this.practice=practice;this.records=[];this.stages=[];this.index=0;this.running=true;
   const c=this.config;
   this.active=practice?{...c,formalTrials:c.practiceTrials,partANodes:c.practiceNodes,...(this.task==='digit'?{maxSpan:c.minSpan,trialsPerSpan:1}:{})}:c;
   const count=this.active.formalTrials;
   if(this.task==='reaction')this.trials=modules['gonogo-test'].buildGoNoGoTrials(count);
   if(this.task==='stroop')this.trials=modules['stroop-test'].buildStroopTrials(count,c.congruentRatio);
   if(this.task==='flanker')this.trials=modules['flanker-test'].buildFlankerTrials(Math.ceil(count/6)*6).slice(0,count);
   if(this.task==='nback')this.trials=modules['nback-test'].buildNBackTrials(count);
   if(this.task==='digit')this.trials=modules['digit-span-test'].buildDigitTrials(this.active.minSpan,this.active.maxSpan,this.active.trialsPerSpan);
   if(this.task==='trail')return this.trail('A');
   this.next();
  }
  next(){if(!this.live())return;if(this.index>=this.trials.length)return this.finish();
   const t=this.trials[this.index];this.view.dataset.trial=String(this.index+1);
   if(this.task==='reaction')return this.reaction(t);
   if(this.task==='stroop'||this.task==='flanker')return this.choice(t);
   if(this.task==='nback')return this.nback(t);
   if(this.task==='digit')return this.digit(t);
  }
  record(row,delay=250){if(!this.live()||this.phase==='feedback')return;this.clearTimers();this.records.push(row);this.index++;
   this.screen('feedback','作答已记录');this.later(()=>this.next(),delay);}
  elapsed(){return Math.max(0,Math.round(performance.now()-this.startedAt));}
  reaction(type){const m=modules['gonogo-test'];this.screen('waiting',`${this.index+1}/${this.trials.length} · 保持专注，等待页面变色`);
   const target=this.action('等待',()=>{if(this.phase==='waiting')this.record(m.evaluateTrial({type,action:'false_start'}),450);
    else if(this.phase==='stimulus')this.respondReaction(type);});target.className='cognitive-target';this.view.append(target);
   this.later(()=>{this.phase='stimulus';this.view.dataset.phase='stimulus';target.textContent=type==='go'?'点击':'停';target.className='cognitive-target '+(type==='go'?'go':'nogo');this.startedAt=performance.now();
    this.later(()=>{if(this.phase==='stimulus')this.record(m.evaluateTrial({type,action:'timeout'}),450);},this.config.responseWindowMs);
   },[800,1000,1200,1400][this.index%4]);
  }
  respondReaction(type){const elapsed=this.elapsed(),expired=elapsed>this.config.responseWindowMs;
   this.record(modules['gonogo-test'].evaluateTrial({type,action:expired?'timeout':'tap',reactionTimeMs:elapsed}),450);}
  choice(t){const stroop=this.task==='stroop';this.screen('testing',`${this.index+1}/${this.trials.length}`);
   const display=node('p');display.className='cognitive-stimulus';
   if(stroop){const colors=modules['stroop-test'].COLORS;display.textContent=colors.find(v=>v.key===t.wordKey).label;display.style.color=colors.find(v=>v.key===t.colorKey).hex;}
   else{const arrow=t.target==='left'?'←':'→',other=t.target==='left'?'→':'←';display.textContent=t.condition==='congruent'?`${arrow} ${arrow} ${arrow} ${arrow} ${arrow}`:t.condition==='neutral'?`◇ ◇ ${arrow} ◇ ◇`:`${other} ${other} ${arrow} ${other} ${other}`;}
   this.view.append(display);
   const choices=stroop?modules['stroop-test'].COLORS.map(v=>[v.key,v.label]):[['left','向左'],['right','向右']];
   const answer=value=>{if(this.phase!=='testing')return;const elapsed=this.elapsed(),actual=elapsed>this.config.responseWindowMs?'':value;
    this.record(stroop?modules['stroop-test'].evaluateStroopChoice(t,actual,elapsed):modules['flanker-test'].evaluateFlankerTrial(t,actual,elapsed),stroop?450:250);};
   for(const [value,label]of choices){const b=this.action(label,()=>answer(value));b.dataset.answer=value;this.view.append(b);}
   this.startedAt=performance.now();this.later(()=>answer(''),this.config.responseWindowMs);
  }
  nback(t){this.screen('testing',`${this.index+1}/${this.trials.length} · ${t.scored?'判断是否与两次之前相同':'点击黄色方格并记住位置'}`);
   const grid=node('div');grid.className='cognitive-grid';
   for(let i=0;i<9;i++){const b=this.action(i===t.position?'当前位置':'空白位置',()=>{if(!t.scored&&i===t.position&&this.phase==='testing')this.record({...t,answeredMatch:null,outcome:'warmup',correct:null,responseTimeMs:this.elapsed()});});
    b.className=i===t.position?(t.scored?'active':'warmup'):'';b.disabled=t.scored||i!==t.position;grid.append(b);}this.view.append(grid);
   if(t.scored)for(const [value,label]of [[true,'匹配'],[false,'不匹配']])this.view.append(this.action(label,()=>{if(this.phase==='testing')this.record(modules['nback-test'].evaluateNBackAnswer(t,value,this.elapsed()));}));
   this.startedAt=performance.now();
  }
  digit(t){this.screen('presenting',`${t.direction==='forward'?'顺背':'倒背'} · ${t.span}位 · 第${t.attempt}轮`);
   const display=node('p');display.className='cognitive-stimulus';this.view.append(display);let shown=0;
   const show=()=>{if(shown>=t.sequence.length)return this.recall(t);display.textContent=String(t.sequence[shown++]);
    this.later(()=>{display.textContent='';this.later(show,this.config.gapMs);},this.config.digitDurationMs);};show();
  }
  recall(t){this.screen('recall',`${t.direction==='forward'?'顺背：按原顺序输入':'倒背：按相反顺序输入'} · ${t.span}位`);
   const answer=[],display=node('p','已输入0位'),keys=node('div');keys.className='digit-keys';
   const update=()=>{display.textContent='已输入：'+answer.join(' ');};
   for(let digit=0;digit<=9;digit++)keys.append(this.action(String(digit),()=>{if(this.phase==='recall'&&answer.length<100){answer.push(digit);update();}}));
   this.view.append(display,keys,this.action('删除一位',()=>{answer.pop();update();}),this.action('确认本轮答案',()=>{if(this.phase!=='recall')return;
    const m=modules['digit-span-test'],row=m.evaluateDigitTrial(t,answer);this.records.push(row);this.index++;
    if(m.shouldStopDigitDirection(this.records,t.direction,this.active.trialsPerSpan))while(this.index<this.trials.length&&this.trials[this.index].direction===t.direction)this.index++;
    const changed=this.trials[this.index]&&this.trials[this.index].direction!==t.direction;this.screen('feedback',changed?'下一阶段为倒背，请按相反顺序输入。':'作答已记录');this.later(()=>this.next(),changed?1500:450);
   }));
  }
  trail(stage){if(!this.live())return;const m=modules['trail-test'],size=this.practice?this.config.practiceNodes:stage==='A'?this.config.partANodes:this.config.partBPairs;
   const sequence=m.buildTrailSequence(stage,size);this.screen('testing',`${stage}阶段 · ${stage==='A'?'按数字顺序点击':'按数字与字母交替点击'}`);
   const board=node('div');board.className='cognitive-trail';this.view.append(board);board.scrollIntoView({block:'center'});
   const rect=board.getBoundingClientRect(),layout=m.createRandomTrailLayout(sequence,Math.random,{width:rect.width,height:rect.height,nodeSize:40,gap:10});
   const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 100 100');svg.setAttribute('preserveAspectRatio','none');svg.classList.add('trail-lines');board.append(svg);
   let index=0,errors=0,previous=null,lastTap=null;this.startedAt=performance.now();
   for(const position of layout){const b=this.action(position.label,()=>{if(this.phase!=='testing')return;
    const elapsed=this.elapsed();if(lastTap?.label===position.label&&elapsed-lastTap.elapsed<200)return;lastTap={label:position.label,elapsed};
    const expected=sequence[index],out=m.evaluateTrailTap(sequence,index,position.label);this.records.push({stage,label:position.label,expected,correct:out.correct,elapsedMs:elapsed});
    if(!out.correct){errors++;return;}index=out.nextIndex;b.classList.add('completed');
    if(previous){const line=document.createElementNS('http://www.w3.org/2000/svg','line');for(const[key,value]of Object.entries({x1:previous.x,y1:previous.y,x2:position.x,y2:position.y}))line.setAttribute(key,value);svg.append(line);}previous=position;
    if(out.completed){this.stages.push({stage,elapsedMs:this.elapsed(),errors,nodeCount:sequence.length,completed:true});
     if(stage==='A'&&!this.practice){this.screen('transition','A阶段结束。B阶段请按1、A、2、B…交替点击。');this.later(()=>this.trail('B'),2000);}else this.finish();}
   });b.style.left=position.x+'%';b.style.top=position.y+'%';b.className='trail-node';board.append(b);}
  }
  payload(){const context={ageGroup:this.config.ageGroup,mode:'single',practiceAttempts:1,interruptedCount:0},r=this.records,t=this.task;
   if(t==='reaction')return modules['gonogo-test'].buildCognitivePayload(r,new Date().toISOString(),context);
   if(t==='stroop')return modules['stroop-test'].buildStroopPayload(r,new Date().toISOString(),context);
   if(t==='flanker'){const m=modules['flanker-test'];return m.buildFlankerPayload(m.summarizeFlankerTrials(r),r,context);}
   if(t==='nback'){const m=modules['nback-test'];return m.buildNBackPayload(m.summarizeNBackTrials(r),r,context);}
   if(t==='digit'){const m=modules['digit-span-test'];return m.buildDigitSpanPayload(m.summarizeDigitTrials(r),r,context);}
   const m=modules['trail-test'];return m.buildTrailPayload(m.summarizeTrailStages(this.stages),r,context);
  }
  finish(){if(!this.live())return;this.clearTimers();const payload=this.payload();if(!payload)throw Error('实际作答记录不完整，本次不能提交。');
   this.screen('result',this.practice?'练习已完成':'完整测试已完成');this.running=false;this.done(payload,this.practice);}
 }

 function validateAttempt(a,item,session){if(a.actor_user_id!==page.session.accountId||a.submitter_user_id!==page.session.accountId||a.assessment_id!==aid||a.assessment_item_id!==itemId||a.patient_id!==pid||a.performer_patient_id!==pid||a.performer_kind!=='patient'||
  a.protocol_id!==item.protocol_id||a.protocol_schema_version!==6||a.config_digest!==item.config_digest||a.template_digest!==session.template_digest||canonical(a.config_snapshot)!==canonical(item.config)||a.metadata.device.platform!=='web')throw Error('原尝试、实际参与者、执行平台或冻结配置不一致。');}
 async function create(item,input,assisted){if(!confirm('确认测试由当前档案本人实际完成？儿童由儿童本人作答，监护人仅负责操作提交。如有辅助，请如实记录。'))return;
  return page.run(async()=>{const ticket=page.next();attempt=await page.request(`/care/assessment-items/${item.id}/attempts`,{expected_item_version:item.version,protocol_id:item.protocol_id,protocol_schema_version:item.protocol_schema_version,config_digest:item.config_digest,
   repeat_report_id:item.repeat_request?.report_id??null,performer_patient_id:pid,respondent_kind:null,confirmed:true,
   device:{platform:'web',device_type:'browser',viewport_width:innerWidth,viewport_height:innerHeight},input:{method:input},timing:{clock_source:'performance.now',unit:'ms',calibrated:false},
   practice:{completed:false,attempts:0,exposure_count:0},assistance:{provided:assisted,kind:assisted?'guardian_or_other_assistance':'none'},recall_window:null});if(!page.current(ticket))return;
   query.set('attempt_id',attempt.id);history.replaceState({},'',location.pathname+'?'+query);await page.reload();});}
 async function start(item,a,ticket,view){if(!page.current(ticket))return;
  if(!navigator.locks)throw Error('此浏览器不能可靠锁定本次运行，请使用当前版本浏览器。');
  let claimed=false;await navigator.locks.request(marker(a),()=>{if(!page.current(ticket)||localStorage.getItem(marker(a)))return;localStorage.setItem(marker(a),JSON.stringify({started_at:new Date().toISOString(),run_id:a.run_id}));claimed=true;});
  if(!claimed){page.say('本次尝试已开始或已中断，请重新读取后创建新尝试。');return;}
  document.getElementById('clinicalRefresh').disabled=true;
  const practiceRecords=[];const done=(payload,practice)=>{
   if(!page.current(ticket))return;
   if(practice){const trials=payload.result_json.trials,scored=trials.filter(row=>row.scored!==false),score=item.instrument==='trail'?Math.round(100*a.config_snapshot.practiceNodes/trials.length):Math.round(100*scored.filter(row=>row.correct===true).length/scored.length);
    practiceRecords.push({attempt:practiceRecords.length+1,trials:JSON.parse(JSON.stringify(trials))});
    const passed=score>=a.config_snapshot.practicePassPercent;view.append(node('p',`练习正确率 ${score}% · ${passed?'已通过':'未通过'}`));
    if(passed)view.append(button('开始正式测试',()=>{if(page.current(ticket))engine.begin(false);}));
    else if(practiceRecords.length<a.config_snapshot.maxPracticeAttempts)view.append(button('再次练习',()=>{if(page.current(ticket))engine.begin(true);}));
    else{page.say('本次三次练习未通过，请返回评估安排新尝试。');document.getElementById('clinicalRefresh').disabled=false;}return;}
   payload.result_json={...payload.result_json,source:'patient_web',protocol_id:a.protocol_id,protocol_schema_version:a.protocol_schema_version,test_run_id:a.run_id,actual_trials:payload.result_json.trials.length};
   completed={...payload,execution_metadata:{...Object.fromEntries(['device','input','timing','assistance'].map(key=>[key,a.metadata[key]])),practice:{completed:true,attempts:practiceRecords.length,exposure_count:a.metadata.practice.exposure_count},practice_records:practiceRecords,interrupted_count:0}};
   document.getElementById('clinicalRefresh').disabled=false;view.append(node('p','全部实际作答已完成。提交后由服务器重新计分；保存、质量与医生验收分别记录。'),button('确认保存本次全部原始作答',()=>submit(item,a)));
  };
  engine=new Executor(item.instrument,a.config_snapshot,view,()=>page.current(ticket),a.metadata.input.method,done);engine.begin(true);
 }
 async function submit(item,a){if(!completed)return;const content=JSON.parse(JSON.stringify(completed)),p={submission_id:'web-'+a.run_id,kind:'cognitive',patient_id:pid,assessment_id:aid,assessment_item_id:itemId,attempt_id:a.id,run_id:a.run_id,task_id:item.patient_task_id??null,content};
  for(const key of ['protocol_id','protocol_schema_version','config_digest','template_digest','actor_user_id','performer_kind','performer_user_id','performer_patient_id','respondent_user_id','respondent_kind','submitter_user_id'])p[key]=a[key];
  const context=Object.fromEntries(Object.entries(p).filter(([key])=>key!=='content'));
  await page.submit({label:'本轮完整认知任务原始作答',idField:'submission_id',tokenField:null,contextField:null,contextDigest:await hash(context),ackType:'assessment_submission',route:'/care/submissions',queryRoute:'/care/submissions/',payload:p,
   confirm:'确认按实际参与者、实际设备、练习和逐次作答提交？提交后保留原结果，不把网页与其他设备的分数直接合并。'});
 }
 page.reload=async()=>{halt();document.getElementById('clinicalRefresh').disabled=false;const ticket=page.next(),view=page.area('clinicalInputs'),historyView=page.area('clinicalHistory');view.replaceChildren();historyView.replaceChildren();
  await page.pendingView();if(!page.current(ticket))return;const session=await page.request(`/care/assessments/${aid}`);if(!page.current(ticket))return;
  if(session.id!==aid||session.patient_id!==pid)throw Error('本轮评估与当前档案不一致。');const item=session.items.find(row=>row.id===itemId);
  if(!item||item.kind!=='cognitive'||item.protocol_id!=='continuous-mobile-v4'||!names[item.instrument])throw Error('请从具体完整认知评估项目进入。');
  view.append(node('h2',item.title),node('p','网页完整任务使用本轮冻结规则。结果用于记录本次表现，跨设备可比性、计时校准及专业模板准入仍需核验。'));
  attempt=item.attempts.find(row=>row.id===Number(query.get('attempt_id')))||null;
  if(item.protocol_schema_version!==6||canonical(modules['cognitive-config'].getTaskConfig(item.instrument,session.age_group))!==canonical(item.config))throw Error('当前网页版本不支持本轮冻结协议或配置，请更新后重新进入。');
  if(attempt?.execution_status==='submitted'){const ack=await page.request('/care/submissions/'+encodeURIComponent('web-'+attempt.run_id));if(!page.current(ticket))return;
   const original=await page.request(`/care/submissions/${encodeURIComponent(ack.submission_id)}/evidence`);if(!page.current(ticket))return;
   if(original.context.patient_id!==pid||original.context.attempt_id!==attempt.id)throw Error('服务器原结果归属不一致。');
   historyView.append(node('h2','本次服务器结果'),node('p',`已保存 · 数据质量：${ack.quality_status==='valid'?'记录完整':'需要关注'} · 医生验收：${ack.acceptance_status==='not_required'?'自主记录，无医生验收':ack.acceptance_status==='accepted'?'已验收':'待医生确认'} · 跨设备可比性未验证`));
   const result=original.server_result.result_json||original.server_result;for(const metric of result.metrics||[])historyView.append(node('p',`${metric.label}：${metric.value}`));
   if(result.raw_result)historyView.append(node('pre',JSON.stringify(result.raw_result,null,2)));page.say('本次尝试已真实提交，原始记录与服务器结果保留。');return;}
  if(page.pending){page.say('本机已有待确认原件，请先按原编号查询。');return;}
  const canCreate=(item.allowed_actions||[]).includes('create_attempt');
  if(!attempt||localStorage.getItem(marker(attempt))){if(attempt)view.append(node('p','这个尝试已经开始或中断。原编号保留，重新测试必须创建新尝试。'));
   if(canCreate){const label=node('label','本次实际输入方式：'),select=node('select');select.setAttribute('aria-label','本次实际输入方式');for(const[v,t]of [['mouse','鼠标'],['touch','触屏'],['keyboard','键盘（使用Tab和空格选择按钮）']]){const option=node('option',t);option.value=v;select.append(option);}select.value=matchMedia('(pointer:coarse)').matches?'touch':'mouse';label.append(select);
    const help=node('label'),checkbox=node('input');checkbox.type='checkbox';help.append(checkbox,node('span','本次有监护人或他人辅助（如实记录，交医生判断）'));view.append(label,help,button('确认实际参与者并创建新尝试',()=>create(item,select.value,checkbox.checked)));}
   page.say(canCreate?'确认实际参与者与输入方式后开始。':'当前评估状态不允许新增尝试。');return;}
  validateAttempt(attempt,item,session);if(attempt.execution_status!=='in_progress')throw Error('这个尝试当前不能执行。');
  if(attempt.metadata.device.viewport_width!==innerWidth||attempt.metadata.device.viewport_height!==innerHeight)throw Error('当前显示区域与原尝试不同，请创建新尝试。');
  view.append(node('h3',names[item.instrument]),node('p',instructions[item.instrument]),node('p',`先完成练习，达到${attempt.config_snapshot.practicePassPercent}%后进入正式测试，最多练习${attempt.config_snapshot.maxPracticeAttempts}次。切换页面或调整窗口会中断本次执行。`));
  const captured=attempt,startButton=button('请先阅读说明（3秒）',()=>{if(!startButton.disabled)page.run(()=>start(item,captured,ticket,view));});startButton.disabled=true;view.append(startButton);
  setTimeout(()=>{if(page.current(ticket)){startButton.disabled=false;startButton.textContent='已阅读，开始练习';}},3000);page.say('请阅读说明，并确保实际参与者已经准备好。');
 };page.run(page.reload);
})();
