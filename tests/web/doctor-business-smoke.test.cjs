const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{setTimeout:pause}=require('node:timers/promises'),puppeteer=require('puppeteer-core');
const root=path.resolve(__dirname,'../..');
test('doctor web saves a real private review, explicitly publishes a report and real dated plan',{timeout:240000},async()=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin=`http://127.0.0.1:${port}`,base=origin+'/api/v1';
 const server=spawn(path.join(root,'.venv/Scripts/python.exe'),[path.join(root,'tests/web/isolated_review_server.py'),String(port)],{cwd:root,windowsHide:true,env:{...process.env,APP_ENV:'test',CARE_WORKER_ENABLED:'false',DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});
 let browser,log='';server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
 async function api(route,auth,body){const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth.access_token}:{}),...(route.startsWith('/__synthetic__/')?{'X-Synthetic-Test':'w06-local-synthetic-only'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
 try{
  for(let i=0;i<300;i++){try{if((await fetch(origin)).ok)break;}catch{}if(i===299)throw Error('startup failed');await pause(100);}
  const{owner,doctor,assessment}=await api('/__synthetic__/review-source',null,{child:true});
  browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,userDataDir:fs.mkdtempSync(path.join(root,'.codex-tmp/doctor-business-')),args:['--no-first-run','--disable-background-networking']});
  const page=await browser.newPage();page.on('dialog',d=>d.accept());await page.setViewport({width:430,height:900});
  await page.evaluateOnNewDocument(({base,doctor})=>{window.SMARTBRAIN_API_BASE_URL=base;localStorage.setItem('smartbrain_token',doctor.access_token);localStorage.setItem('smartbrain_user',JSON.stringify(doctor.user));},{base,doctor});
  async function click(text){await page.evaluate(text=>{const el=Array.from(document.querySelectorAll('button')).find(n=>n.textContent===text);if(!el)throw Error('button missing '+text);el.click();},text);}
  await page.goto(`${origin}/doctor-web/doctor_review.html?patient_id=${assessment.patient_id}&assessment_id=${assessment.id}`,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('textarea[aria-label="实际医生意见"]',{timeout:60000});
  await page.type('[aria-label="实际医生意见"]','本人核对合成实际材料，尚有执行局限，需核对后续资料。');await page.type('[aria-label="本次审核局限"]','演示材料，不能形成诊断结论。');
  await page.$$eval('select[aria-label^="原件"]',fields=>fields.forEach(n=>{n.value='needs_repeat';n.dispatchEvent(new Event('change',{bubbles:true}));}));
  await page.$$eval('textarea[aria-label^="原件"]',fields=>fields.forEach(n=>{n.value='核对实际执行条件后请求重测。';n.dispatchEvent(new Event('input',{bubbles:true}));}));
  await click('确认保存本人私人审核草稿');await page.waitForFunction(()=>Array.from(document.querySelectorAll('#clinicalHistory button')).some(n=>n.textContent.includes('草稿')),{timeout:60000});
  await page.evaluate(()=>Array.from(document.querySelectorAll('#clinicalHistory button')).find(n=>n.textContent.includes('草稿')).click());
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(n=>n.textContent==='核对并明确发布这份草稿'));
  await click('核对并明确发布这份草稿');await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(n=>n.textContent==='确认发布给用户'));
  await click('确认发布给用户');await page.waitForFunction(()=>document.querySelector('#clinicalHistory')?.textContent.includes('第 1 版'),{timeout:60000});
  const reports=await api(`/care/assessments/${assessment.id}/reports`,owner);assert.equal(reports.items.length,1);
  await page.goto(`${origin}/doctor-web/doctor_plan.html?patient_id=${assessment.patient_id}&assessment_id=${assessment.id}`,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('[aria-label="实际计划标题"]',{timeout:60000});await page.type('[aria-label="实际计划标题"]','医生网页实际日期安排');await page.type('[aria-label="具体安排与注意事项"]','按实际日期记录，未知保持为空，不判断治疗效果。');
  await page.evaluate(()=>document.querySelector('#clinicalInputs form').requestSubmit());
  await page.waitForFunction(()=>document.querySelector('#clinicalHistory')?.textContent.includes('医生网页实际日期安排'),{timeout:60000});
  const plans=await api(`/care/plans?patient_id=${assessment.patient_id}`,owner);assert.ok(plans.items[0].versions[0].cycle_id);assert.ok(plans.items[0].tasks.length);
  console.log(JSON.stringify({actual_chrome:true,actual_http:true,private_review:true,published_report_id:reports.items[0].id,actual_plan_id:plans.items[0].id,actual_cycle_id:plans.items[0].versions[0].cycle_id,actual_tasks:plans.items[0].tasks.length}));
 }finally{await browser?.close();server.kill();await Promise.race([new Promise(r=>server.once('exit',r)),pause(2000)]);fs.writeFileSync(path.join(root,'docs/evidence/doctor-business-smoke-server.txt'),log);}
});
