// Controlled synthetic responses through the real frozen client generators.
const fs = require('node:fs')
const path = require('node:path')
const input = JSON.parse(fs.readFileSync(0,'utf8'))
const base = path.resolve(__dirname,'../../miniprogram/utils')
const config = input.config
let seed = 71623
const random = () => { seed = (1664525*seed+1013904223)>>>0; return seed/4294967296 }
const context = {ageGroup:config.ageGroup,mode:'single',practiceAttempts:1,interruptedCount:0}
const load = name => require(path.join(base,name))
function records(task,count,practice=false) {
  if(task==='reaction') { const m=load('gonogo-test'); return m.buildGoNoGoTrials(count,random).map((type,i)=>({trial:i+1,...m.evaluateTrial({type,action:type==='go'?'tap':'timeout',reactionTimeMs:400})})) }
  if(task==='stroop') { const m=load('stroop-test'); return m.buildStroopTrials(count,config.congruentRatio,random).map((trial,i)=>({trial:i+1,...m.evaluateStroopChoice(trial,trial.colorKey,400)})) }
  if(task==='flanker') { const m=load('flanker-test'); return m.buildFlankerTrials(Math.ceil(count/6)*6,random).slice(0,count).map((trial,i)=>m.evaluateFlankerTrial({...trial,id:i+1},trial.target,400)) }
  if(task==='nback') { const m=load('nback-test'); return m.buildNBackTrials(count,random).map((trial,i)=> i<2?{...trial,answeredMatch:null,outcome:'warmup',correct:null,responseTimeMs:400}:m.evaluateNBackAnswer(trial,trial.isTarget,400)) }
  if(task==='digit') { const m=load('digit-span-test'); return m.buildDigitTrials(config.minSpan,practice?config.minSpan:config.maxSpan,practice?1:config.trialsPerSpan,random).map(trial=>m.evaluateDigitTrial(trial,trial.direction==='backward'?trial.sequence.slice().reverse():trial.sequence)) }
  if(task==='trail') { const m=load('trail-test'); const stages=practice?['A']:['A','B']; return stages.flatMap(stage=>m.buildTrailSequence(stage,practice?config.practiceNodes:stage==='A'?config.partANodes:config.partBPairs).map((label,i)=>({stage,label,expected:label,correct:true,elapsedMs:(i+1)*100}))) }
}
const task=config.taskId
const formal=records(task,config.formalTrials)
const practiceCount = task==='digit'?2:task==='trail'?config.practiceNodes:config.practiceTrials
const practice=records(task,practiceCount,true)
let payload
if(task==='reaction') payload=load('gonogo-test').buildCognitivePayload(formal,new Date().toISOString(),context)
if(task==='stroop') payload=load('stroop-test').buildStroopPayload(formal,new Date().toISOString(),context)
if(task==='flanker') { const m=load('flanker-test'); payload=m.buildFlankerPayload(m.summarizeFlankerTrials(formal),formal,context) }
if(task==='nback') { const m=load('nback-test'); payload=m.buildNBackPayload(m.summarizeNBackTrials(formal),formal,context) }
if(task==='digit') { const m=load('digit-span-test'); payload=m.buildDigitSpanPayload(m.summarizeDigitTrials(formal),formal,context) }
if(task==='trail') { const m=load('trail-test'); const stages=['A','B'].map(stage=>({stage,elapsedMs:3000,errors:0,nodeCount:30,completed:true})); payload=m.buildTrailPayload(m.summarizeTrailStages(stages),formal,context) }
payload.result_json.source='miniprogram'
payload.result_json.protocol_id=config.protocolId
payload.result_json.protocol_schema_version=config.schemaVersion
payload.result_json.test_run_id=input.run_id
payload.result_json.actual_trials=formal.length
process.stdout.write(JSON.stringify({payload,practice_records:[{attempt:1,trials:practice}]}))
