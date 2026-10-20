const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{setTimeout:pause}=require('node:timers/promises');
const puppeteer=require('puppeteer-core'),root=path.resolve(__dirname,'../..');
test('S2 real Chrome / TCP: both roles, explicit smart preview, private real forms and original recovery',{timeout:300000},async()=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const origin=`http://127.0.0.1:${port}`,base=origin+'/api/v1',server=spawn(path.join(root,'.venv/Scripts/python.exe'),[path.join(root,'tests/web/isolated_review_server.py'),String(port)],
  {cwd:root,windowsHide:true,env:{...process.env,APP_ENV:'test',DEEPSEEK_API_KEY:'',CARE_WORKER_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
 let browser,log='',stage='startup';const proof=[],errors=[],responses=[];server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
 async function api(route,auth,body,status=200){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth.access_token}:{}),...(route.startsWith('/__synthetic__/')?{'X-Synthetic-Test':'w06-local-synthetic-only'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;}
 try{
  for(let n=0;n<300;n++){if(server.exitCode!==null)throw Error(log);try{if((await fetch(origin)).ok)break;}catch{}if(n===299)throw Error('Synthetic server startup timeout');await pause(100);}
  const {owner,doctor,assessment}=await api('/__synthetic__/review-source',null,{minimal:true}),pid=assessment.patient_id;
  await api('/patient/consents',owner,{patient_id:pid,purpose:'external_ai',scope:['care'],terms_version:'W02-1'},201);
  const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10),cycle=await api('/care/cycles',owner,{client_cycle_id:'s2-web-cycle',patient_id:pid,start_date:day,end_date:day,cycle_type:'self'},201);
  await api('/care/daily-records',owner,{client_submission_id:'s2-existing',patient_id:pid,cycle_id:cycle.id,record_date:day,expected_revision:0,recorded_at:null,content:{note:'原备注',focus_minutes:20}},201);
  stage='browser_launch';browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,userDataDir:fs.mkdtempSync(path.join(root,'.codex-tmp/s2-web-agent-')),args:['--no-first-run','--disable-background-networking']});
  for(const [role,auth,file]of[['patient',owner,'patient-web/patient_ai.html'],['doctor',doctor,'doctor-web/doctor_agent.html']]){
   const context=await browser.createBrowserContext(),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{if(r.url()===base+'/agent/runs'&&r.request().method()==='POST')try{const v=await r.json();responses.push({status:r.status(),detail:v.detail,accepted:v.accepted,original_request:v.original_request});}catch(_){}});await page.setViewport({width:430,height:1000});
   await page.evaluateOnNewDocument(({base,auth})=>{window.SMARTBRAIN_API_BASE_URL=base;localStorage.setItem('smartbrain_token',auth.access_token);localStorage.setItem('smartbrain_user',JSON.stringify(auth.user));},{base,auth});
   const runPosts=[],observations=[];let loseDaily=false,lostDaily=false,smartMismatch=false,holdActions=false,heldActions;
   await page.setRequestInterception(true);page.on('request',async req=>{
    if(req.method()==='POST'&&req.url()===base+'/agent/runs')runPosts.push(JSON.parse(req.postData()));
    if(req.method()==='POST'&&req.url()===base+'/agent/companion-observations')observations.push(JSON.parse(req.postData()));
    if(holdActions&&req.url().startsWith(base+'/agent/actions?')){const r=await fetch(req.url(),{headers:req.headers()});heldActions={req,status:r.status,body:await r.text()};return;}
    if(smartMismatch&&req.url().includes('/agent/run-context?')&&req.url().includes('question_mode=smart')){smartMismatch=false;const r=await fetch(req.url(),{headers:req.headers()}),data=await r.json();data.conversation_preview.turns[0].assistant_message+='替换';return req.respond({status:r.status,contentType:'application/json',body:JSON.stringify(data)});}
    if(loseDaily&&!lostDaily&&req.method()==='POST'&&req.url()===base+'/care/daily-records'){lostDaily=true;const r=await fetch(req.url(),{method:'POST',headers:req.headers(),body:req.postData()});assert.equal(r.status,201);await r.json();return req.abort('failed');}
    req.continue();
   });
   stage=role+'_navigate';await page.goto(`${origin}/${file}?patient_id=${pid}&assessment_id=${assessment.id}`,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>!document.querySelector('#agentSend').disabled,{timeout:60000});
   assert.ok(await page.$('#agentQuestionMode'),'question mode and per-request smart preview must exist');
   stage=role+'_ordinary_answer';await page.select('#agentQuestionMode','local');await page.type('#agentInput','注意力分心了，如何记录？');await page.click('#agentSend');
   await page.waitForFunction(()=>document.querySelector('#agentHistory .agent-reply')?.textContent&&!document.querySelector('#agentSend').disabled,{timeout:90000});
   assert.equal(runPosts.length,1);assert.equal(runPosts[0].external_message_consent,undefined);assert.equal(runPosts[0].context_run_ids,undefined);
   assert.equal(await page.$$eval('#agentHistory a',ns=>ns.filter(n=>n.href.includes('draft')).length),0);
   stage=role+'_smart_preview';await page.select('#agentQuestionMode','smart');await page.click('#agentContextChoices input');await page.type('#agentInput','继续刚才，怎样保存？');
   await page.click('#agentSend');await page.waitForSelector('#agentSmartPreview:not([hidden])');
   assert.ok((await page.$eval('#agentSmartPreview',n=>n.textContent)).includes('注意力分心了，如何记录？'));assert.equal(runPosts.length,1);
   await page.click('#agentSmartCancel');assert.equal(runPosts.length,1);
   smartMismatch=true;await page.click('#agentSend');await page.waitForFunction(()=>document.querySelector('#agentMessage').textContent.includes('变化'));
   assert.equal(runPosts.length,1);assert.equal(await page.$eval('#agentSmartPreview',n=>n.hidden),true);
   await page.click('#agentSend');await page.waitForSelector('#agentSmartPreview:not([hidden])');await page.click('#agentSmartConfirm');
   await page.waitForFunction(()=>document.querySelectorAll('#agentHistory .agent-reply').length>=2&&!document.querySelector('#agentSend').disabled,{timeout:90000});
   assert.equal(runPosts.length,2);assert.equal(runPosts[1].external_message_consent.version,'Xingzai-selected-dialogue-1');assert.equal(runPosts[1].context_run_ids.length,1);
   await page.select('#agentQuestionMode','local');
   stage=role+'_actual_form';if(role==='patient'){
    await page.type('#agentInput','帮我记录：今天专注有困难');await page.click('#agentBusinessChoices button');await page.waitForSelector('#agentBusinessOptions button');await page.click('#agentBusinessOptions button');
    await page.waitForSelector('#agentBusinessForm iframe');const handle=await page.$('#agentBusinessForm iframe'),frame=await handle.contentFrame();
    await frame.waitForSelector('#dailyNote');assert.equal(await frame.$eval('#dailyNote',n=>n.value),'原备注\n今天专注有困难');assert.equal(await frame.$eval('#dailyDate',n=>n.value),day);
    assert.ok(!frame.url().includes(encodeURIComponent('困难')));assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).length),0);
    loseDaily=true;page.on('dialog',d=>d.accept());await frame.click('#dailySave');await frame.waitForFunction(()=>document.querySelector('#clinicalPending button')?.textContent.includes('查询'));
    await frame.waitForFunction(()=>document.querySelector('#clinicalShell').getAttribute('aria-busy')!=='true');await frame.click('#clinicalPending button');await frame.waitForFunction(()=>document.querySelector('#clinicalStatus').textContent.includes('已读取'));
    const detail=await api('/care/cycles/'+cycle.id,owner),record=detail.records.find(r=>r.record_date===day);assert.equal(record.revision,2);assert.equal(record.content.focus_minutes,20);assert.equal(record.content.note,'原备注\n今天专注有困难');assert.equal(lostDaily,true);
    await page.click('#agentBusinessClose');await page.$eval('#agentInput',n=>n.value='');
   }
   await page.type('#agentInput',role==='patient'?'告诉医生：今天专注有困难':'告诉用户：请记录真实日期');await page.click('#agentBusinessChoices button');await page.waitForSelector('#agentBusinessOptions button');await page.click('#agentBusinessOptions button');
   await page.waitForSelector('#agentBusinessForm iframe');const formFrame=await(await page.$('#agentBusinessForm iframe')).contentFrame();
   await formFrame.waitForFunction(()=>document.querySelector('#clinicalInputs textarea')?.value);
   const text=await formFrame.$eval('#clinicalInputs textarea',n=>n.value);assert.ok(text.includes(role==='patient'?'告诉医生':'告诉用户'));
   if(role==='doctor')page.on('dialog',d=>d.accept());await formFrame.waitForFunction(()=>document.querySelector('#clinicalShell').getAttribute('aria-busy')!=='true');await formFrame.click('#clinicalInputs button[type=submit]');
   await formFrame.waitForFunction(expected=>document.querySelector('#clinicalHistory').textContent.includes(expected)&&document.querySelector('#clinicalShell').getAttribute('aria-busy')!=='true',{},text);
   const relations=await api('/care/shared-messages/relationships?patient_id='+pid,auth),relation=relations.items.find(r=>r.can_send);
   const messages=await api(`/care/shared-messages?patient_id=${pid}&relationship_id=${relation.relationship_id}`,role==='patient'?doctor:owner);assert.ok(messages.items.some(m=>m.content===text));
   await page.screenshot({path:path.join(root,`docs/evidence/s2-web-${role}.png`),fullPage:true});await page.click('#agentBusinessClose');
   await page.$eval('#agentCompanion',n=>n.scrollIntoView());await page.waitForFunction(()=>document.querySelector('#agentCompanion').dataset.observed==='true',{timeout:30000});
   const observed=observations.length;holdActions=true;await page.click('#agentRefresh');for(let n=0;n<600&&!heldActions;n++)await pause(50);assert.ok(heldActions);
   await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await heldActions.req.respond({status:heldActions.status,contentType:'application/json',body:heldActions.body});await pause(250);
   assert.equal(observations.length,observed);assert.equal(await page.$eval('#agentHistory',n=>n.textContent),'');assert.equal(await page.$eval('#agentBusinessForm',n=>n.textContent),'');
   holdActions=false;await page.goto(`${origin}/${file}?patient_id=99999999`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#agentMessage').textContent.includes('授权范围'));
   assert.equal(await page.$eval('#agentSend',n=>n.disabled),true);assert.equal(await page.$eval('#agentHistory',n=>n.textContent),'');
   for(const key of ['assessment_id','cycle_id']){await page.goto(`${origin}/${file}?patient_id=${pid}&${key}=99999999`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#agentMessage').textContent.includes('不在当前可用范围'));assert.equal(await page.$eval('#agentSend',n=>n.disabled),true);}
   proof.push({role,ordinary_answer_direct:true,smart_cancel_zero_post:true,selected_full_preview:true,tampered_preview_rejected:true,smart_explicit_consent:true,actual_private_form:true,actual_message_read_by_other_role:true,hidden_response_not_observed:true,...(role==='patient'?{actual_daily_revision:2,prior_fields_preserved:true,lost_daily_ack_recovered_by_get:true}:{})});await context.close();
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(root,'docs/evidence/s2-web-receipt.json'),JSON.stringify({actual_chrome:true,actual_tcp:true,synthetic_temporary_stores:true,external_model_called:false,proof},null,2));
 }catch(error){fs.writeFileSync(path.join(root,'docs/evidence/s2-web-failure.json'),JSON.stringify({stage,message:error.message,stack:error.stack,proof,errors,responses},null,2));
  if(browser)for(const p of await browser.pages())try{const texts=[];for(const f of p.frames())texts.push(await f.evaluate(()=>document.body.innerText));fs.writeFileSync(path.join(root,'docs/evidence/s2-web-failure-page.txt'),texts.join('\nFRAME\n'));}catch(_){}throw error;
 }finally{server.kill();fs.writeFileSync(path.join(root,'docs/evidence/s2-web-server.txt'),log);await browser?.close();await Promise.race([new Promise(r=>server.once('exit',r)),pause(3000)]);}
});
