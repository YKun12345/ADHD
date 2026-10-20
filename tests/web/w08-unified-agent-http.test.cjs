const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{setTimeout:pause}=require('node:timers/promises');
const puppeteer=require('puppeteer-core'),root=path.resolve(__dirname,'../..');
test('both actual web roles use the same durable Agent, recover a lost ACK by original GET and clear private results on hide',{timeout:240000},async()=>{
    const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
    const origin=`http://127.0.0.1:${port}`,base=origin+'/api/v1';
    const server=spawn(path.join(root,'.venv/Scripts/python.exe'),[path.join(root,'tests/web/isolated_review_server.py'),String(port)],
        {cwd:root,windowsHide:true,env:{...process.env,APP_ENV:'test',DEEPSEEK_API_KEY:'',CARE_WORKER_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
    let browser,log='';const observations=[],errors=[];server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
    async function api(route,auth,body,expected=200){const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',
        ...(auth?{Authorization:'Bearer '+auth.access_token}:{}),...(route.startsWith('/__synthetic__/')?{'X-Synthetic-Test':'w06-local-synthetic-only'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
        const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;}
    try{
        for(let n=0;n<300;n++){if(server.exitCode!==null)throw Error(log);try{if((await fetch(origin)).ok)break;}catch{}if(n===299)throw Error('Synthetic server startup timeout');await pause(100);}
        const {owner,doctor,assessment}=await api('/__synthetic__/review-source',null,{minimal:true});
        browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
            userDataDir:fs.mkdtempSync(path.join(root,'.codex-tmp/w08-web-agent-')),args:['--no-first-run','--disable-background-networking']});
        for(const [role,auth,other,file]of[['patient',owner,doctor,'patient-web/patient_ai.html'],['doctor',doctor,owner,'doctor-web/doctor_agent.html']]){
            const context=await browser.createBrowserContext(),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:430,height:900});
            await page.evaluateOnNewDocument(({base,auth})=>{window.SMARTBRAIN_API_BASE_URL=base;localStorage.setItem('smartbrain_token',auth.access_token);localStorage.setItem('smartbrain_user',JSON.stringify(auth.user));},{base,auth});
            let postCount=0,originalGets=0,lost=false,actualAck;
            await page.setRequestInterception(true);page.on('request',async request=>{
                if(request.url()===base+'/agent/runs'&&request.method()==='POST'){
                    postCount++;if(!lost){lost=true;try{const response=await fetch(request.url(),{method:'POST',headers:request.headers(),body:request.postData()});
                        assert.equal(response.status,202);actualAck=await response.json();await request.abort('failed');}catch(error){errors.push(error.message);await request.abort();}return;}
                }
                if(request.url().includes('/agent/runs/submissions/'))originalGets++;
                request.continue();
            });
            await page.goto(`${origin}/${file}?patient_id=${assessment.patient_id}&assessment_id=${assessment.id}`,{waitUntil:'domcontentloaded'});
            await page.waitForFunction(()=>!document.querySelector('#agentSend').disabled,{timeout:60000});
            const question='请按实际原件说明缺失 <img src=x onerror="window.agentXss=true">';
            await page.type('#agentInput',question);await page.click('#agentSend');
            await page.waitForFunction(()=>!document.querySelector('#agentQuery').hidden&&!document.querySelector('#agentQuery').disabled,{timeout:60000});
            assert.equal(postCount,1);assert.ok(actualAck?.run_id);
            const second=role==='patient'?await page.evaluate(()=>{
                const first=Object.keys(localStorage).find(k=>k.startsWith('smartbrain_agent_pending_v1:'));
                const value=JSON.parse(localStorage.getItem(first));
                if(!first.endsWith(':'+value.payload.client_run_id))throw Error('Each original needs its own durable key');
                value.payload.client_run_id='other-tab-'+crypto.randomUUID();value.payload.message='另一标签尚未发送的合成原件';
                const key=first.slice(0,first.lastIndexOf(':')+1)+value.payload.client_run_id,raw=JSON.stringify(value);
                localStorage.setItem(key,raw);return{key,raw};
            }):null;
            await page.click('#agentQuery');
            await page.waitForFunction(()=>!document.querySelector('#agentQuery').disabled&&document.querySelector('#agentHistory .agent-reply')?.textContent,{timeout:90000});
            assert.equal(postCount,1);assert.equal(originalGets,1);
            if(second){assert.equal(await page.evaluate(key=>localStorage.getItem(key),second.key),second.raw);
                await page.click('#agentQuery');await page.waitForFunction(()=>!document.querySelector('#agentRetry').hidden,{timeout:30000});
                assert.equal(postCount,1);assert.equal(originalGets,2);
                assert.equal(await page.evaluate(key=>localStorage.getItem(key),second.key),second.raw);
                // Only the synthetic, never-sent second-tab fixture is removed.
                await page.evaluate(key=>localStorage.removeItem(key),second.key);await page.reload({waitUntil:'domcontentloaded'});
                await page.waitForFunction(()=>!document.querySelector('#agentSend').disabled&&document.querySelector('#agentHistory .agent-reply')?.textContent,{timeout:60000});
            }
            const run=await api('/agent/runs/'+actualAck.run_id,auth);assert.equal(run.status,'completed');assert.equal(run.mode,'rules');
            assert.equal(run.artifact.body.summary.submitted_items,0);assert.equal(run.artifact.body.summary.missing_items,7);
            const reply=await page.$eval('#agentHistory .agent-reply',n=>n.textContent);assert.equal(reply,run.artifact.body.reply);
            assert.equal(await page.evaluate(()=>Boolean(window.agentXss)),false);assert.equal(await page.$eval('#agentHistory',n=>n.querySelectorAll('img').length),0);
            await api('/agent/runs/'+actualAck.run_id,other,undefined,403);
            assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('smartbrain_agent_pending_v1:')).length),0);
            assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
            await page.screenshot({path:path.join(root,`docs/evidence/w08-web-agent-${role}.png`),fullPage:true});
            await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));assert.equal(await page.$eval('#agentHistory',n=>n.textContent),'');
            assert.equal(await page.$eval('#agentInput',n=>n.value),'');
            observations.push({role,actual_actor_id:auth.user.id,actual_patient_id:assessment.patient_id,actual_run_id:actualAck.run_id,
                actual_artifact_id:run.artifact.id,actual_post_count:postCount,original_gets:originalGets,exact_reply:true,missing_items:7,
                cross_actor_denied:true,plain_text:true,hidden_cleared:true,other_original_preserved:role==='patient',uncommitted_original_get_only:role==='patient'});console.log('verified_web_role:'+role);await context.close();
        }
        assert.deepEqual(errors,[]);fs.writeFileSync(path.join(root,'docs/evidence/w08-unified-agent-web-receipt.json'),JSON.stringify({actual_chrome:true,actual_tcp_http:true,
            synthetic_temporary_stores:true,actual_external_model_called:false,native_wechat_verified:false,observations},null,2));
    }finally{await browser?.close();server.kill();await Promise.race([new Promise(r=>server.once('exit',r)),pause(3000)]);
        fs.writeFileSync(path.join(root,'docs/evidence/w08-unified-agent-web-server.txt'),log);}
});
