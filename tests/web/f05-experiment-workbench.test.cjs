const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),puppeteer=require('puppeteer-core');
const root=path.resolve(__dirname,'../..');
test('synthetic controller fixture: frozen experiment originals, lost ACK, stable forms and private lifecycle',{timeout:60000},async()=>{
 const state={experiments:[],receipts:{},posts:[],gets:[],lost:false};
 const project={id:71,name:'合成实验项目',purpose:'合成控制器验证',institution_id:'synthetic-a',status:'active',revision:4,expires_at:'2030-01-01T00:00:00Z',members:[],nodes:['a','b','c'].map((id,i)=>({id,name:'合成节点'+id,institution_id:'synthetic-'+i,status:'approved',effective_status:'approved',link_id:id,link_revision:2,weight:1,identity_verified:true,runtime_admitted:true}))};
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),route=url.pathname.replace('/api/v1','');let data;
  if(url.pathname.startsWith('/api/v1/')){
   if(req.method==='POST'){
    let text='';for await(const part of req)text+=part;const p=JSON.parse(text);state.posts.push({route,p});
    if(route.endsWith('/experiments')){const e={id:'fixture-exp-1',project_id:71,revision:1,status:'draft',configuration:p,configuration_digest:'fixture-digest',completed_rounds:0,research_only:true,clinical_activation_allowed:false};state.experiments.push(e);data=e;}
    else if(route.endsWith('/preflight')){data=state.experiments[0];assert.equal(p.expected_revision,data.revision);data.revision++;data.status='ready';data.preflight={status:'passed',projected_privacy:{epsilon:2.4,delta:0.00001},secure_rng:false,encoder_dp_protected:false};}
    else if(route.endsWith('/start')){data=state.experiments[0];assert.equal(p.expected_revision,data.revision);data.revision++;data.status='queued';}
    else if(route.endsWith('/stop')){data=state.experiments[0];data.revision++;data.status='cancelled';}
    else{res.writeHead(404);res.end('{}');return;}
    state.receipts[p.client_request_id]={id:'receipt-'+p.client_request_id,actor_user_id:9001,client_request_id:p.client_request_id,submission_status:'committed',original_request:p,result:structuredClone(data)};
   }else{
    state.gets.push(route);
   if(route==='/federated/projects')data=state.scope||{projects:[project],nodes:[],node_invitations:[],reviewer_institutions:['synthetic-a']};
    else if(route==='/federated/projects/71')data=project;
    else if(route.endsWith('/bases'))data={items:[{id:81,label:'合成已核验基座',artifact_sha256:'a'.repeat(64),input_contract_digest:'b'.repeat(64)}]};
    else if(route.endsWith('/experiments'))data={items:state.experiments};
    else if(route.endsWith('/rounds'))data={experiment_id:'fixture-exp-1',items:[]};
    else if(route.endsWith('/models'))data={items:[]};
    else if(route.endsWith('/privacy'))data={overall:{epsilon:0,delta:0.00001},maximum_epsilon:10,composition:'conservative_sequential_all_institutions',secure_rng:false,encoder_dp_protected:false,real_data_allowed:false,notice:'保守预留不退还'};
    else if(route.startsWith('/federated/submissions/'))data=state.receipts[route.split('/').at(-1)];
    else if(route==='/federated/experiments/fixture-exp-1')data=state.experiments[0];
   }
   res.writeHead(data?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(data||{}));return;
  }
  if(url.pathname==='/entry-fixture'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<section data-research-entry hidden></section><script src="/doctor-web/js/session-guard.js"></script><script src="/doctor-web/js/api.js"></script><script src="/doctor-web/js/research-entry.js"></script>');return;}
  const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8'});res.end(fs.readFileSync(file));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;let browser,debugPage;
 try{
  browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,userDataDir:fs.mkdtempSync(path.join(root,'.codex-tmp/f05-fixture-')),args:['--no-first-run','--disable-background-networking']});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept(d.type()==='prompt'?'合成控制器验证理由':undefined));
  debugPage=page;await page.evaluateOnNewDocument(origin=>{window.SMARTBRAIN_API_BASE_URL=origin+'/api/v1';localStorage.setItem('smartbrain_token','synthetic-fixture-only');localStorage.setItem('smartbrain_user',JSON.stringify({id:9001,role:'researcher'}));},origin);
  await page.goto(origin+'/doctor-web/federated_workbench.html',{waitUntil:'domcontentloaded'});
  await page.waitForSelector('[aria-label="研究基座"]',{timeout:5000});
  await page.waitForSelector('#clinicalShell:not([aria-busy])');
  await page.evaluate(()=>{for(const box of document.querySelectorAll('[data-experiment-create] input[type=checkbox]'))box.checked=true;document.querySelector('[aria-label="计划轮数"]').value='2';document.querySelector('[data-experiment-create] button').click();});
  await page.waitForSelector('[data-experiment-status="draft"]');await page.waitForSelector('#clinicalShell:not([aria-busy])');
  assert.equal(state.posts[0].route,'/federated/projects/71/experiments');assert.deepEqual(state.posts[0].p.node_ids,['a','b','c']);assert.equal(state.posts[0].p.rounds,2);assert.equal(state.posts[0].p.base_model_version_id,81);
  await page.evaluate(()=>{const native=window.fetch;window.fetch=async(...args)=>{const r=await native(...args);if(!window.__lost&&String(args[0]).endsWith('/preflight')&&args[1]?.method==='POST'){window.__lost=true;await r.clone().text();throw Error('Synthetic fixture loses committed response');}return r;};[...document.querySelectorAll('[data-experiment-id] button')].find(b=>b.textContent==='运行真实预检').click();});
  await page.waitForSelector('#clinicalPending article');await page.waitForSelector('#clinicalShell:not([aria-busy])');
  const count=state.posts.length;await page.evaluate(()=>document.querySelector('#clinicalPending button').click());await page.waitForSelector('[data-experiment-status="ready"]');await page.waitForSelector('#clinicalShell:not([aria-busy])');assert.equal(state.posts.length,count);
  await page.evaluate(()=>[...document.querySelectorAll('[data-experiment-id] button')].find(b=>b.textContent==='启动后台实验').click());await page.waitForSelector('[data-experiment-status="queued"]');await page.waitForSelector('#clinicalShell:not([aria-busy])');
  await page.evaluate(()=>{document.querySelector('[aria-label="计划轮数"]').value='5';window.__form=document.querySelector('[data-experiment-create]');});
  await new Promise(r=>setTimeout(r,5500));assert.equal(await page.$eval('[aria-label="计划轮数"]',e=>e.value),'5');assert.equal(await page.evaluate(()=>window.__form===document.querySelector('[data-experiment-create]')),true);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});const reads=state.gets.length;await new Promise(r=>setTimeout(r,5500));assert.equal(state.gets.length,reads);assert.equal(await page.$eval('#clinicalHistory',e=>e.textContent),'');assert.deepEqual(errors,[]);
  const entry=await browser.newPage();await entry.evaluateOnNewDocument(origin=>{window.SMARTBRAIN_API_BASE_URL=origin+'/api/v1';localStorage.setItem('smartbrain_token','synthetic-entry-token');localStorage.setItem('smartbrain_user',JSON.stringify({id:9001,role:'researcher'}));},origin);
  state.scope={projects:[],reviewer_institutions:[]};await entry.goto(origin+'/entry-fixture');await new Promise(r=>setTimeout(r,250));assert.equal(await entry.$('[data-research-entry] a'),null,'ordinary doctor account gets no research link');
  state.scope={projects:[project],reviewer_institutions:[]};await entry.reload();await entry.waitForSelector('[data-research-entry]:not([hidden]) a');assert.equal(await entry.$eval('[data-research-entry] a',e=>e.getAttribute('href')),'federated_workbench.html');
  assert.equal(await entry.evaluate(()=>{localStorage.setItem('smartbrain_user',JSON.stringify({id:9002,role:'researcher'}));dispatchEvent(new Event('focus'));return !document.querySelector('[data-research-entry] a');}),true);
  console.log(JSON.stringify({synthetic_api_fixture:true,real_chrome:true,real_original_transport:true,lost_ack_get_only:true,form_preserved:true,hidden_cleared:true,scoped_entry:true,entry_session_cleared:true}));
 }catch(error){console.log(JSON.stringify({diagnostic:await debugPage?.evaluate(()=>({text:document.body.innerText,attrs:document.querySelector('#clinicalShell').outerHTML.slice(0,300),first:document.querySelector('[data-experiment-id]')?.textContent,hidden:document.hidden})).catch(()=>null),posts:state.posts,gets:state.gets}));throw error;}finally{await browser?.close();await new Promise(r=>server.close(r));}
});


