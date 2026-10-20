const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process'),{setTimeout:pause}=require('node:timers/promises'),puppeteer=require('puppeteer-core');const root=path.resolve(__dirname,'../..');
test('six full web cognitive tasks save actual browser actions in the real temporary backend',{timeout:360000},async()=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin=`http://127.0.0.1:${port}`,base=origin+'/api/v1';
 const server=spawn(path.join(root,'.venv/Scripts/python.exe'),[path.join(root,'tests/web/isolated_review_server.py'),String(port)],{cwd:root,windowsHide:true,env:{...process.env,APP_ENV:'test',CARE_WORKER_ENABLED:'false',DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});let browser,log='';server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
 async function api(route,auth,body){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth.access_token}:{}),...(route.startsWith('/__synthetic__/')?{'X-Synthetic-Test':'w06-local-synthetic-only'}:{})},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;}
 try{for(let i=0;i<300;i++){try{if((await fetch(origin)).ok)break;}catch{}if(i===299)throw Error('startup timeout');await pause(100);}
  const{owner,assessment}=await api('/__synthetic__/review-source',null,{minimal:true});
  browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,userDataDir:fs.mkdtempSync(path.join(root,'.codex-tmp/formal-cognitive-')),args:['--no-first-run','--disable-background-networking']});const page=await browser.newPage();page.on('dialog',d=>d.accept());const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.evaluateOnNewDocument(({base,owner})=>{window.SMARTBRAIN_API_BASE_URL=base;localStorage.setItem('smartbrain_token',owner.access_token);localStorage.setItem('smartbrain_user',JSON.stringify(owner.user));},{base,owner});
  async function clickText(text){const handle=await page.evaluateHandle(text=>Array.from(document.querySelectorAll('button')).find(n=>n.textContent===text),text);const el=handle.asElement();assert.ok(el,`Missing button ${text}: `+await page.$eval('#clinicalStatus',n=>n.textContent));await el.click();await handle.dispose();}
  const receipts=[];
  for(const task of ['reaction','stroop','flanker','nback','trail','digit']){
   const item=assessment.items.find(row=>row.instrument===task);assert.ok(item);
   await page.goto(`${origin}/patient-web/patient_formal_cognitive.html?patient_id=${assessment.patient_id}&assessment_id=${assessment.id}&item_id=${item.id}`,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(n=>n.textContent==='确认实际参与者并创建新尝试'),{timeout:30000});
   await clickText('确认实际参与者并创建新尝试');
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(n=>n.textContent==='已阅读，开始练习'&&!n.disabled),{timeout:30000});await clickText('已阅读，开始练习');
   let last='',digits=[],digitKey='',positions=[],trailNext=0,trailStage='',saved=false;
   const until=Date.now()+120000;
   while(Date.now()<until){
    const state=await page.$eval('#clinicalInputs',n=>({phase:n.dataset.phase,practice:n.dataset.practice,trial:n.dataset.trial,text:n.textContent,stimulus:n.querySelector('.cognitive-stimulus')?.textContent,color:n.querySelector('.cognitive-stimulus')?.style.color,active:Array.from(n.querySelectorAll('.cognitive-grid button')).findIndex(n=>n.className==='active'||n.className==='warmup'),buttons:Array.from(n.querySelectorAll('button')).map(b=>b.textContent)}));
    if(state.buttons.includes('开始正式测试')){await clickText('开始正式测试');last='';digits=[];digitKey='';positions=[];trailNext=0;trailStage='';continue;}
    if(state.buttons.includes('确认保存本次全部原始作答')){await clickText('确认保存本次全部原始作答');saved=true;break;}
    const key=state.practice+':'+state.trial+':'+state.phase;
    if(task==='reaction'&&state.phase==='stimulus'&&last!==key&&state.buttons.includes('点击')){await page.click('.cognitive-target');last=key;}
    if(task==='stroop'&&state.phase==='testing'&&last!==key){const color={'rgb(200, 92, 82)':'red','rgb(63, 139, 127)':'green','rgb(57, 118, 184)':'blue','rgb(213, 155, 45)':'yellow'}[state.color];assert.ok(color,state.color);await page.click(`[data-answer=${color}]`);last=key;}
    if(task==='flanker'&&state.phase==='testing'&&last!==key){await page.click(`[data-answer=${state.stimulus.trim().split(/\s+/)[2]==='←'?'left':'right'}]`);last=key;}
    if(task==='nback'&&state.phase==='testing'&&last!==key){const match=positions.length>=2&&positions.at(-2)===state.active;positions.push(state.active);if(positions.length<=2)await page.click('.cognitive-grid button.warmup');else await clickText(match?'匹配':'不匹配');last=key;}
    if(task==='trail'&&state.phase==='testing'){
     const stage=state.text.includes('A阶段')?'A':'B',stageKey=state.practice+stage;if(stageKey!==trailStage){trailStage=stageKey;trailNext=0;}
     const label=stage==='A'?String(trailNext+1):trailNext%2?String.fromCharCode(65+Math.floor(trailNext/2)):String(Math.floor(trailNext/2)+1);
     const target=await page.evaluateHandle(label=>Array.from(document.querySelectorAll('.trail-node')).find(n=>n.textContent===label),label);if(target.asElement()){await target.asElement().click();trailNext++;}await target.dispose();
    }
    if(task==='digit'){
     const k=state.practice+':'+state.text.split('位')[0];if(state.phase==='presenting'){
      if(k!==digitKey){digitKey=k;digits=[];last='';}
      if(state.stimulus&&last!=='digit:'+state.stimulus){digits.push(state.stimulus);last='digit:'+state.stimulus;}else if(!state.stimulus)last='';
     }
     if(state.phase==='recall'&&last!=='recalled:'+digitKey){
      if(state.practice==='true'){const actual=state.text.includes('倒背')?digits.slice().reverse():digits;assert.equal(actual.length,3,JSON.stringify({digits,state}));for(const digit of actual)await clickText(digit);}
      // Explicitly submit an empty formal answer; two real failures must stop each direction.
      await clickText('确认本轮答案');last='recalled:'+digitKey;
     }
    }
    assert.equal(errors.length,0,errors.join('\n'));await pause(task==='trail'?15:35);
   }
   assert.ok(saved,task+' did not reach complete submission: '+await page.$eval('#clinicalStatus',n=>n.textContent));
   await page.waitForFunction(()=>document.querySelector('#clinicalStatus')?.textContent.includes('本次尝试已真实提交'),{timeout:30000});
   const updated=await api('/care/assessments/'+assessment.id,owner),a=updated.items.find(n=>n.id===item.id).attempts.at(-1),ack=await api('/care/submissions/web-'+a.run_id,owner),evidence=await api(`/care/submissions/${ack.submission_id}/evidence`,owner);
   assert.equal(ack.result.legacy,false);assert.equal(evidence.client_evidence.result_json.source,'patient_web');assert.equal(evidence.client_evidence.execution_metadata.device.platform,'web');assert.equal(evidence.client_evidence.execution_metadata.practice_records.length,1);
   assert.equal(evidence.client_evidence.result_json.trials.length,{reaction:25,stroop:24,flanker:24,nback:24,trail:60,digit:4}[task]);assert.equal(ack.comparability_status,'not_verified');
   receipts.push({task,attempt:a.id,submission:ack.submission_id,actual_trials:evidence.client_evidence.result_json.trials.length,quality:ack.quality_status});console.log(JSON.stringify(receipts.at(-1)));
  }
  assert.equal(errors.length,0);console.log(JSON.stringify({actual_chrome:true,actual_http:true,tasks:receipts}));
 }finally{await browser?.close();server.kill();await Promise.race([new Promise(r=>server.once('exit',r)),pause(2000)]);if(log.trim())console.log(log.slice(-1500));}
});
