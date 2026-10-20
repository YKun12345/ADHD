const {test}=require('node:test'), assert=require('node:assert/strict');
const {matchesAck}=require('../../patient-web/js/agent-original');
test('web Agent only clears the exact actual owner, original request and accepted run ACK',()=>{
    const payload={client_run_id:'web-original',patient_id:9,intent:'question',assessment_id:null,cycle_id:null,
        message:'合成问题',expected_context_digest:'a'.repeat(64),run_context:'signed-original'};
    const entry={owner:{accountId:7,role:'patient',patientId:9,revision:'original-login'},payload,contextDigest:'b'.repeat(64)};
    const ack={accepted:true,id:3,run_id:3,actor_user_id:7,patient_id:9,client_run_id:'web-original',submission_status:'committed',legacy:false,
        input_digest:payload.expected_context_digest,run_context_digest:entry.contextDigest,original_request:{...payload}};
    assert.equal(matchesAck(entry,ack),true);
    for(const changed of [{actor_user_id:8},{patient_id:10},{run_id:4},{client_run_id:'another'},
        {legacy:true},{accepted:false},{submission_status:'pending'},{input_digest:'x'},
        {run_context_digest:'x'},{original_request:{...payload,message:'另一个问题'}},{original_request:{...payload,extra:true}}])
        assert.equal(matchesAck(entry,{...ack,...changed}),false,JSON.stringify(changed));
});
