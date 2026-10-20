/* Exact original ACK matching is shared by the actual page and focused checks. */
((root,factory)=>{ const value=factory(); if(typeof module==='object'&&module.exports) module.exports=value; else root.AgentOriginal=value; })(typeof window==='undefined'?globalThis:window,()=>{
    const canonical=value=>JSON.stringify(sort(value));
    function sort(value){ if(Array.isArray(value))return value.map(sort); if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])); return value; }
    function matchesAck(entry,ack){
        const p=entry?.payload,o=entry?.owner;
        return Boolean(p&&o&&ack&&Number.isSafeInteger(ack.id)&&ack.id>0&&ack.id===ack.run_id&&ack.accepted===true&&
            ack.legacy===false&&ack.submission_status==='committed'&&ack.actor_user_id===o.accountId&&ack.patient_id===o.patientId&&
            ack.client_run_id===p.client_run_id&&ack.input_digest===p.expected_context_digest&&
            ack.run_context_digest===entry.contextDigest&&canonical(ack.original_request)===canonical(p));
    }
    return {canonical,matchesAck};
});
