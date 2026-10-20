const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process'),{setTimeout:pause}=require('node:timers/promises'),puppeteer=require('puppeteer-core');const root=path.resolve(__dirname,'../..');
test('patient web completes actual frozen scale answers and receives the real formal submission ACK',{timeout:120000},async()=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin=`http://127.0.0.1:${port}`,base=origin+'/api/v1';
 const server=spawn(path.join(root,'.venv/Scripts/python.exe'),[path.join(root,'tests/web/isolated_review_server.py'),String(port)],{cwd:root,windowsHide:true,env:{...process.env,APP_ENV:'test',CARE_WORKER_ENABLED:'false',DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});let browser,log='';server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
 async function api(route,auth,body){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth.access_token}:{}),...(route.startsWith('/__synthetic__/')?{'X-Synthetic-Test':'w06-local-synthetic-only'}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
 try{for(let i=0;i<300;i++){try{if((await fetch(origin)).ok)break;}catch{}if(i===299)throw Error('startup timeout');await pause(100);}
  const{owner,assessment}=await api('/__synthetic__/review-source',null,{minimal:true}),item=assessment.items.find(row=>row.kind==='scale');
  browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,userDataDir:fs.mkdtempSync(path.join(root,'.codex-tmp/formal-scale-')),args:['--no-first-run','--disable-background-networking']});const page=await browser.newPage();page.on('dialog',d=>d.accept());
  await page.evaluateOnNewDocument(({base,owner})=>{window.SMARTBRAIN_API_BASE_URL=base;localStorage.setItem('smartbrain_token',owner.access_token);localStorage.setItem('smartbrain_user',JSON.stringify(owner.user));},{base,owner});
  await page.goto(`${origin}/patient-web/patient_formal_scale.html?patient_id=${assessment.patient_id}&assessment_id=${assessment.id}&item_id=${item.id}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#clinicalStatus')?.textContent,{timeout:30000});
  assert.ok(await page.evaluate(()=>Array.from(document.querySelectorAll('button')).some(n=>n.textContent==='确认实际填写人并开始新尝试')),await page.$eval('#clinicalStatus',n=>n.textContent));
  await page.evaluate(()=>Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='确认实际填写人并开始新尝试').click());await page.waitForSelector('input[type=radio]',{timeout:30000});
  await page.evaluate(()=>{for(const first of document.querySelectorAll('fieldset input[type=radio]:first-of-type')){if(first.value==='0')first.click();}});
  // Select the actual first response explicitly in every question.
  await page.evaluate(()=>Array.from(document.querySelectorAll('fieldset')).forEach(n=>n.querySelector('input[type=radio]').click()));
  await page.evaluate(()=>document.querySelector('#clinicalInputs form').requestSubmit());
  await page.waitForFunction(()=>document.querySelector('#clinicalStatus')?.textContent.includes('本次尝试已真实提交'),{timeout:45000});
  const updated=await api(`/care/assessments/${assessment.id}`,owner),attempt=updated.items.find(row=>row.id===item.id).attempts[0],ack=await api('/care/submissions/web-'+attempt.run_id,owner);
  assert.equal(ack.submission_status,'committed');assert.equal(ack.result.kind,'scale');assert.equal(ack.result.legacy,false);
  const actual=await api(`/care/submissions/${ack.submission_id}/evidence`,owner);assert.equal(actual.server_result.total_score,0);assert.equal(actual.client_evidence.answers.length,item.config.questions.length);
  console.log(JSON.stringify({actual_chrome:true,actual_http:true,actual_submission_id:ack.submission_id,actual_attempt_id:attempt.id,total_score:actual.server_result.total_score}));
 }finally{await browser?.close();server.kill();await Promise.race([new Promise(r=>server.once('exit',r)),pause(2000)]);if(log.trim())console.log(log.slice(-1500));}
});
