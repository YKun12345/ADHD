const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./rendering-browser-harness.cjs');
let harness;
after(async () => { await harness?.close(); });
const attack = '<img src=x onerror="window.__transferXss=1">';
const proposal = { id:31, patient_id:8, author_user_id:9, receiver_doctor_user_id:3,
    requested_at:'2026-10-16T04:00:00+00:00', reason:attack,
    sources:[{ source_type:'attention', source_id:12, expected_version:1 }] };
const work = { id:51, patient_id:8, transfer_id:31, decision_id:41, responsible_doctor_id:3,
    from_doctor_user_id:80, original_attention_id:12, accepted_at:'2026-10-16T04:10:00+00:00',
    status:'acknowledged', version:2, expected_response_at:null, original_provenance_preserved:true };
async function open({ doctor = false, foreign = false, delayed = false } = {}) {
    harness ||= await start();
    const page = await harness.page(doctor ? 'doctor-web/doctor_transfers.html' : 'patient-web/patient_transfers.html',null);
    await page.evaluate(doctor => {
        localStorage.setItem('smartbrain_token','synthetic-fixed-account');
        localStorage.setItem('smartbrain_user',JSON.stringify({ id:doctor ? 3 : 9, role:doctor ? 'researcher':'patient',patient_profile:doctor ? null:{id:8} }));
        window.SMARTBRAIN_API_BASE_URL = `${location.origin}/api/v1`;
    },doctor);
    const calls = [], pending = {};
    page.removeAllListeners('request');
    page.on('request',request => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/v1/')) return request.abort();
        calls.push({path:url.pathname,method:request.method()});
        const send = data => request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
        if (url.pathname.endsWith('/identity/context')) return send({user_id:doctor ? 3:9,accessible_patients:doctor ? []:[{patient_id:8,display_name:'合成档案'}]});
        if (url.pathname.endsWith('/responsibility-transfers')) return send({items:[{request:proposal,status:'accepted',version:2}]});
        if (url.pathname.endsWith('/transferred-work')) return send({items:[{...work,...(foreign ? doctor ? {responsible_doctor_id:99}:{patient_id:99}:{})}]});
        if (url.pathname.endsWith('/transferred-work/51')) {
            const detail = {work,original_evidence:{attention_id:12,original_doctor_user_id:80,quality_reasons:['execution_interrupted'],evidence:{client_evidence:{note:attack}}}};
            if (delayed) {pending.detail=()=>send(detail);return;}
            return send(detail);
        }
        if (url.pathname.endsWith('/51/history')) return send({work_item_id:51,items:[{action_id:61,work_item_id:51,patient_id:8,actor_user_id:3,action:'acknowledge',occurred_at:work.accepted_at,reason:attack}]});
        return send({});
    });
    for (const file of [(doctor ? 'doctor-web' : 'patient-web') + '/js/session-guard.js',
        (doctor ? 'doctor-web' : 'patient-web') + '/js/api.js', 'doctor-web/js/transfer-view.js']) {
        await page.addScriptTag({content:fs.readFileSync(path.resolve(__dirname,'../..',file),'utf8')});
    }
    return {page,calls,pending};
}
test('both actual web roles read accepted handover, exact root and actor history using escaped text and GET only',async()=>{
    for (const doctor of [false,true]) {
        const {page,calls}=await open({doctor});
        try {
            await page.waitForFunction(()=>document.querySelector('#transferMessage').textContent.includes('已读取'));
            assert.match(await page.$eval('#transferRequests',n=>n.textContent),/接收医生已接受/);
            await page.click('[data-transfer-work-id="51"]');
            await page.waitForFunction(()=>document.querySelector('#transferDetail').textContent.includes('账号 3'));
            await page.click('#transferDetail summary');
            assert.match(await page.$eval('#transferDetail',n=>n.textContent),/执行过程有中断/);
            assert.ok((await page.$eval('#transferDetail',n=>n.textContent)).includes(attack));
            assert.equal(await page.$('#transferDetail img'),null);assert.equal(await page.evaluate(()=>window.__transferXss),undefined);
            assert.ok(calls.length>=5);assert.ok(calls.every(call=>call.method==='GET'));
        } finally {await page.close();}
    }
});
test('foreign patient or foreign actual doctor responsibility hides every sensitive view',async()=>{
    for (const doctor of [false,true]) {
        const {page}=await open({doctor,foreign:true});
        try {
            await page.waitForFunction(()=>document.querySelector('#transferMessage').textContent.includes('不一致'));
            assert.equal(await page.$eval('#transferRequests',n=>n.textContent),'');
            assert.equal(await page.$eval('#transferWork',n=>n.textContent),'');
        } finally {await page.close();}
    }
});
test('hiding the fixed account page clears private data and an actual late source response cannot restore it',async()=>{
    const {page,pending}=await open({delayed:true});
    try {
        await page.waitForSelector('[data-transfer-work-id="51"]');await page.click('[data-transfer-work-id="51"]');
        for (let i=0;i<50&&!pending.detail;i++) await new Promise(resolve=>setTimeout(resolve,20));
        assert.ok(pending.detail);await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
        await pending.detail();
        assert.equal(await page.$eval('#transferDetail',n=>n.textContent),'');
        assert.equal(await page.$eval('#transferRequests',n=>n.textContent),'');
    } finally {await page.close();}
});
