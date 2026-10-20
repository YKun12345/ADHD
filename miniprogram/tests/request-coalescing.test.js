const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
function harness() {
  const sent = [], storage = { access_token:'synthetic-token', current_user:{id:7,role:'patient'}, api_base_url:'https://api.example.com/api/v1' }
  let revision = 0
  const module = {exports:{}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/request.js'),'utf8'), {
    module, console:{error(){}}, wx:{getStorageSync:key=>storage[key],request:options=>sent.push(options)},
    require(name) { if(name==='./api-config')return require('../utils/api-config')
      if(name==='./session-privacy')return {SESSION_KEYS:[],getPatientDataRevision:()=>revision,hasValidPatientSession:()=>true,reLaunchSafely(){},endPatientSession(){revision++;return {ok:true,failedKeys:[]}}}
      throw new Error(name) }
  })
  return {sent,storage,request:module.exports.request,advance(){revision++},ok(index,data={items:[{id:8}]}){sent[index].success({statusCode:200,data})}}
}
test('identical concurrent reads share one transport, return independent objects, and never cache a completed result', async()=>{
  const h=harness(), a=h.request({url:'/identity/context'}), b=h.request({url:'/identity/context'})
  assert.equal(h.sent.length,1)
  h.ok(0)
  const [x,y]=await Promise.all([a,b]);x.items[0].id=99;assert.equal(y.items[0].id,8)
  const fresh=h.request({url:'/identity/context'});assert.equal(h.sent.length,2);h.ok(1);await fresh
})
test('different query, server, token, actor, revision or auth mode cannot share a pending read',async()=>{
  const h=harness(), pending=[]
  const send=options=>{const p=h.request(options);pending.push(p.catch(()=>null))}
  send({url:'/care/assessments?patient_id=8'});send({url:'/care/assessments?patient_id=9'})
  h.storage.api_base_url='https://other.example.com/api/v1';send({url:'/care/assessments?patient_id=8'})
  h.storage.access_token='next-token';send({url:'/care/assessments?patient_id=8'})
  h.storage.current_user={id:9,role:'researcher'};send({url:'/care/assessments?patient_id=8'})
  h.advance();send({url:'/care/assessments?patient_id=8'});send({url:'/care/assessments?patient_id=8',skipAuth:true})
  assert.equal(h.sent.length,7);h.sent.forEach((_,i)=>h.ok(i));await Promise.all(pending)
})
test('writes fence earlier and during-write reads, and late cleanup cannot delete a newer pending read',async()=>{
  const h=harness(), before=h.request({url:'/care/cycles'}), write=h.request({url:'/care/cycles',method:'POST',data:{id:'synthetic'}})
  const during=h.request({url:'/care/cycles'});assert.equal(h.sent.length,3)
  h.ok(1);await write
  const after=h.request({url:'/care/cycles'});assert.equal(h.sent.length,4)
  h.ok(0);h.ok(2);await Promise.all([before,during])
  const joined=h.request({url:'/care/cycles'});assert.equal(h.sent.length,4)
  h.ok(3);await Promise.all([after,joined])
  const w1=h.request({url:'/care/cycles',method:'POST'}),w2=h.request({url:'/care/cycles',method:'POST'})
  assert.equal(h.sent.length,6);h.ok(4);h.ok(5);await Promise.all([w1,w2])
})
test('a transport failure reaches every reader and the next retry sends a new request',async()=>{
  const h=harness(), a=h.request({url:'/auth/me'}).catch(e=>e.code), b=h.request({url:'/auth/me'}).catch(e=>e.code)
  assert.equal(h.sent.length,1);h.sent[0].fail({errMsg:'request:fail timeout'})
  assert.deepEqual(await Promise.all([a,b]),['REQUEST_TIMEOUT','REQUEST_TIMEOUT'])
  const retry=h.request({url:'/auth/me'});assert.equal(h.sent.length,2);h.ok(1);await retry
})
