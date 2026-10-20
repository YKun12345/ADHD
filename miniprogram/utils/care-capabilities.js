// Actual supported frozen formats; this declaration never grants permissions.
const { getTaskConfig } = require('./cognitive-config')
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value)
const CLIENT_CAPABILITIES=Object.freeze({contract_version:1,submission_schema_versions:Object.freeze([1]),
  cognitive_protocol_id:'continuous-mobile-v4',cognitive_schema_version:6,scale_protocol_id:'project-legacy-scale-v1',scale_schema_version:1})
function supportsItem(item,ageGroup){
  if(!item)return false
  if(item.kind==='cognitive')return item.protocol_id===CLIENT_CAPABILITIES.cognitive_protocol_id&&item.protocol_schema_version===6&&
    canonical(getTaskConfig(item.instrument,ageGroup))===canonical(item.config)
  return item.kind==='scale'&&item.protocol_id===CLIENT_CAPABILITIES.scale_protocol_id&&item.protocol_schema_version===1&&
    ['ASRS','SNAP_IV'].includes(item.instrument)&&Array.isArray(item.config&&item.config.questions)&&typeof item.content_digest==='string'
}
module.exports={CLIENT_CAPABILITIES,supportsItem}
