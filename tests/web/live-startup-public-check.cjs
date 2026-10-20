// Public, read-only checks against the explicitly restarted local service.
// No account login, registration, provider request or business write is performed.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {setTimeout:pause}=require('node:timers/promises');
const puppeteer=require('puppeteer-core');
const root=path.resolve(__dirname,'../..');
(async()=>{
    const origin='http://127.0.0.1:8000', checks=[];
    for(let attempt=0;attempt<60;attempt++){
        try{if((await fetch(origin+'/api/v1/health')).ok)break;}catch(_){}
        if(attempt===59)throw new Error('Local application is unavailable');
        await pause(500);
    }
    for(const [url,expected] of [['/api/v1/health',200],['/openapi.json',200],
        ['/doctor-web/login.html',200],['/patient-web/login.html',200],
        ['/api/v1/auth/me',401],['/api/v1/model/admission',401],['/api/v1/doctor/my_patients',401]]){
        const response=await fetch(origin+url);assert.equal(response.status,expected,url);
        checks.push({path:url,status:response.status});
    }
    const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
        userDataDir:fs.mkdtempSync(path.join(root,'.codex-tmp/live-public-browser-')),
        args:['--no-first-run','--disable-background-networking']});
    const errors=[];
    try{
        const page=await browser.newPage();await page.setViewport({width:1280,height:900});
        page.on('pageerror',error=>errors.push(error.message));
        await page.setRequestInterception(true);
        page.on('request',request=>request.url().startsWith(origin)||request.url().startsWith('data:')?request.continue():request.abort());
        await page.goto(origin+'/doctor-web/login.html',{waitUntil:'networkidle0'});
        assert.ok(await page.$('input[type="password"]'),'Login password input exists');
        await page.screenshot({path:path.join(root,'docs/evidence/live-service-login-20261018.png'),fullPage:true});
        assert.deepEqual(errors,[]);
        const result={origin,actual_service:true,checks,browser_errors:errors,real_account_used:false,business_writes_performed:false};
        fs.writeFileSync(path.join(root,'docs/evidence/live-service-public-check-20261018.json'),JSON.stringify(result,null,2));
        console.log(JSON.stringify(result));
    }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
