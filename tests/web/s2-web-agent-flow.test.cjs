const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const file=path.resolve(__dirname,'../../patient-web/js/agent-flow.js');
const flow=fs.existsSync(file)?require(file):{};
const hash='a'.repeat(64), owner={accountId:7,role:'patient',patientId:9,revision:'login-one'};
const token=ctx=>'unified-agent-run-context.v1.'+Buffer.from(JSON.stringify(ctx)).toString('base64url')+'.'+'b'.repeat(64);
const run=(id=1)=>({run_id:id,actor_user_id:7,patient_id:9,intent:'question',status:'completed',original_message:'注意力如何记录？',artifact:{body:{reply:'选择真实日期。'}}});
function context(ids=[1]){const preview={policy_version:'Xingzai-selected-dialogue-1',digest:hash,turns:ids.map(id=>({run_id:id,user_message:run(id).original_message,assistant_message:run(id).artifact.body.reply}))};
const ctx={actor_user_id:7,patient_id:9,role:'patient',question_mode:'smart',external_ai:{field_policy_version:preview.policy_version},conversation_preview:preview};return {...ctx,run_context:token(ctx)};}
test('web choices reject other actors, profiles, unfinished and professional drafts',()=>{
assert.equal(typeof flow.contextChoices,'function','context selection is not implemented');
assert.deepEqual(flow.contextChoices([run(),{...run(2),actor_user_id:8},{...run(3),patient_id:10},{...run(4),status:'running'},{...run(5),intent:'reply_draft'}],owner).map(r=>r.run_id),[1]);
});
test('web smart preview requires exact selected complete text bound in signed original',()=>{
assert.equal(typeof flow.verifiedPreview,'function','full signed preview is not implemented');
assert.equal(flow.verifiedPreview(context(),[1],[run()],owner).turns[0].assistant_message,'选择真实日期。');
for(const change of [c=>c.conversation_preview.turns[0].assistant_message+='篡改',c=>c.patient_id=10,c=>c.question_mode='local',c=>c.run_context=token({...context(),patient_id:10})]){
const c=context();change(c);assert.throws(()=>flow.verifiedPreview(c,[1],[run()],owner));}
assert.throws(()=>flow.verifiedPreview(context([1,2,3]),[1,2,3],[run(),run(2),run(3)],owner));
});
test('tab private one shot bridge rejects another window, expired and changed version without exposing text',()=>{
assert.equal(typeof flow.createBridge,'function','private form bridge is not implemented');
let now=1000,active=true;const bridge=flow.createBridge(()=>active,()=>now),windowA={},windowB={},binding={kind:'message',patientId:9,relationshipId:2,revision:1,contextDigest:hash};
bridge.prepare('one',binding,{content:'私人合成正文'},windowA,owner);
assert.equal(bridge.take('one',binding,windowB,owner),null);
assert.equal(bridge.take('one',{...binding,revision:2},windowA,owner),null);
assert.deepEqual(bridge.take('one',binding,windowA,owner),{content:'私人合成正文'});
assert.equal(bridge.take('one',binding,windowA,owner),null);
bridge.prepare('two',binding,{content:'即将过期'},windowA,owner);now+=120001;assert.equal(bridge.take('two',binding,windowA,owner),null);
bridge.prepare('three',binding,{content:'隐藏'},windowA,owner);active=false;assert.equal(bridge.take('three',binding,windowA,owner),null);
});
test('daily original receipt checks actor, real date, previous version, untouched fields and canonical content digest',async()=>{
assert.equal(typeof flow.matchesDailyAck,'function','real daily receipt verification is not implemented');
const payload={client_submission_id:'daily-1',patient_id:9,cycle_id:2,record_date:'2026-10-18',expected_revision:1,recorded_at:null,content:{note:'原备注\n新备注',focus_minutes:20}};
const normalized={...payload,content:{...payload.content,mood_tag:null}},digest=await flow.digest(normalized);
const ack={...normalized,record_id:4,revision:2,actor_user_id:7,actor_identity_basis:'self',authorization_snapshot:{purpose:'tracking'},legacy:false,submission_status:'committed',content_digest:digest};
assert.equal(await flow.matchesDailyAck({payload,owner},ack),true);
for(const change of [{actor_user_id:8},{cycle_id:3},{record_date:'2026-10-17'},{revision:3},{content:{...ack.content,focus_minutes:30}},{content_digest:'c'.repeat(64)}])assert.equal(await flow.matchesDailyAck({payload,owner},{...ack,...change}),false);
});
