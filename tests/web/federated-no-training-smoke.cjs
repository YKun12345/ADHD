/* Explicit integration runner against isolated_federated_server.py only.
 * No start request is sent. Fixtures, controls and ACK recovery use real HTTP.
 */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const puppeteer=require('puppeteer-core');
const root=path.resolve(__dirname,'../..'),source=JSON.parse(fs.readFileSync(path.join(root,'.codex-tmp/w11-no-training-source.json'),'utf8'));
const origin=process.env.W11_NO_TRAINING_ORIGIN||'http://127.0.0.1:8769',base=origin+'/api/v1';
const mode=process.env.W11_EXPERIMENT_MODE||'dp_secagg';assert.ok(['dp_secagg','synthetic_plaintext'].includes(mode));
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);assert.equal(source.synthetic_only,true);
const auth=source.researcher,headers={Authorization:'Bearer '+auth.access_token,'Content-Type':'application/json'};
async function api(route,body,extra={}){const response=await fetch(base+route,{method:body?'POST':'GET',headers:{...headers,...extra},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.ok(response.ok,route+': '+JSON.stringify(value));return value;}
(async()=>{
 let browser,page,stage='startup';const requests=[],errors=[];
 try{
  await api('/__synthetic__/federated-heartbeats',{}, {'X-Synthetic-Test':'w11-local-synthetic-only'});
  browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,windowsHide:true,userDataDir:fs.mkdtempSync(path.join(root,'.codex-tmp/w11-no-train-chrome-')),args:['--no-first-run','--disable-background-networking']});
  page=await browser.newPage();await page.setViewport({width:1280,height:900});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/federated/'))requests.push(r.url());});
  page.on('dialog',d=>d.accept(d.type()==='prompt'?'仅验证控制与原件恢复，不运行训练。':undefined));
  await page.evaluateOnNewDocument(({base,auth})=>{window.SMARTBRAIN_API_BASE_URL=base;localStorage.setItem('smartbrain_token',auth.access_token);localStorage.setItem('smartbrain_user',JSON.stringify(auth.user));},{base,auth});
  stage='read-page';await page.goto(origin+'/doctor-web/federated_workbench.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('[data-experiment-create] select')&&!document.querySelector('#clinicalShell')?.hasAttribute('aria-busy'),{timeout:60000});
  const modes=await page.$$eval('[aria-label="实验保护模式"] option',rows=>rows.map(v=>v.value));assert.deepEqual(modes,['dp_secagg','synthetic_plaintext']);
  const previous=await page.$$eval('[data-experiment-id]',rows=>rows.map(v=>v.dataset.experimentId));
  stage='create-draft';await page.evaluate(mode=>{const form=document.querySelector('[data-experiment-create]');form.open=true;for(const box of form.querySelectorAll('fieldset input'))box.checked=true;form.querySelector('[aria-label="实验保护模式"]').value=mode;form.querySelector('[aria-label="计划轮数"]').value='2';[...form.querySelectorAll('button')].find(v=>v.textContent==='创建冻结配置实验').click();},mode);
  await page.waitForFunction(previous=>[...document.querySelectorAll('[data-experiment-id]')].some(v=>!previous.includes(v.dataset.experimentId)&&v.dataset.experimentStatus==='draft')&&!document.querySelector('#clinicalShell')?.hasAttribute('aria-busy'),{timeout:60000},previous);
  const eid=await page.$$eval('[data-experiment-id]',(rows,previous)=>rows.find(v=>!previous.includes(v.dataset.experimentId)).dataset.experimentId,previous);
  const draft=await api('/federated/experiments/'+eid);assert.equal(draft.status,'draft');assert.equal(draft.completed_rounds,0);
  stage='preflight-lost-ack';await api('/__synthetic__/federated-heartbeats',{}, {'X-Synthetic-Test':'w11-local-synthetic-only'});
  await page.evaluate(eid=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(!window.lostPreflightAck&&String(args[0]).endsWith('/preflight')&&args[1]?.method==='POST'){window.lostPreflightAck=true;await response.clone().text();throw Error('Synthetic transport lost after actual preflight COMMIT');}return response;};[...document.querySelector(`[data-experiment-id="${eid}"]`).querySelectorAll('button')].find(v=>v.textContent==='运行真实预检').click();},eid);
  await page.waitForFunction(()=>document.querySelector('#clinicalPending')?.textContent.includes('按原编号查询接收结果')&&!document.querySelector('#clinicalShell')?.hasAttribute('aria-busy'),{timeout:60000});
  const before=requests.length;await page.evaluate(()=>document.querySelector('#clinicalPending button').click());
  await page.waitForFunction(eid=>!document.querySelector('#clinicalPending')?.textContent.trim()&&document.querySelector(`[data-experiment-id="${eid}"]`)?.dataset.experimentStatus==='ready'&&!document.querySelector('#clinicalShell')?.hasAttribute('aria-busy'),{timeout:60000},eid);
  assert.equal(requests.length,before,'Original query must not repeat the preflight POST');
  const ready=await api('/federated/experiments/'+eid);assert.equal(ready.status,'ready');assert.equal(ready.preflight.status,'passed');assert.equal(ready.preflight.node_count,3);assert.equal(ready.preflight.mode,mode);assert.equal(ready.preflight.dp_enabled,mode==='dp_secagg');
  stage='stop-unstarted';await page.evaluate(eid=>[...document.querySelector(`[data-experiment-id="${eid}"]`).querySelectorAll('button')].find(v=>v.textContent==='请求安全停止').click(),eid);
  await page.waitForFunction(eid=>document.querySelector(`[data-experiment-id="${eid}"]`)?.dataset.experimentStatus==='cancelled'&&!document.querySelector('#clinicalShell')?.hasAttribute('aria-busy'),{timeout:60000},eid);
  const stopped=await api('/federated/experiments/'+eid),rounds=await api('/federated/experiments/'+eid+'/rounds'),privacy=await api('/federated/projects/'+source.project_id+'/privacy'),audit=await api('/federated/projects/'+source.project_id+'/audit');
  assert.equal(stopped.status,'cancelled');assert.equal(stopped.completed_rounds,0);assert.deepEqual(rounds.items,[]);assert.equal(privacy.overall.epsilon,0);assert.equal(audit.integrity,'verified');
  assert.equal(requests.filter(url=>url.endsWith('/start')).length,0);assert.deepEqual(errors,[]);
  const prefix=mode==='dp_secagg'?'w11-no-training':'w11-plaintext-no-training';
  await page.screenshot({path:path.join(root,`docs/evidence/${prefix}-page.png`),fullPage:true});
  const receipt={actual_chrome:true,actual_http:true,synthetic_only:true,mode,actual_three_institution_node_features:true,project_id:source.project_id,experiment_id:eid,draft_created:true,real_preflight_passed:true,preflight_dp_enabled:ready.preflight.dp_enabled,lost_ack_get_only:true,stopped_status:stopped.status,completed_rounds:0,training_start_requests:0,actual_gradient_training_executed:false,candidate_training_chain_verified:false,privacy_epsilon:privacy.overall.epsilon,audit_integrity:audit.integrity,page_errors:errors};
  fs.writeFileSync(path.join(root,`docs/evidence/${prefix}-http-receipt.json`),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
 }catch(error){if(page)console.log(JSON.stringify({stage,page:await page.evaluate(()=>({status:document.querySelector('#clinicalStatus')?.textContent,text:document.body.innerText.slice(-6000)})).catch(()=>null)}));throw error;}
 finally{await browser?.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
