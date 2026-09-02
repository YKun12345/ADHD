const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

global.wx = {}
const { attachProtocolMetadata } = require('../utils/cognitive-page-support')
const { getTaskConfig } = require('../utils/cognitive-config')

const nbackPayload = { result_json: { raw_result: { total_trials: 22 }, trials: Array(22).fill({}) } }
attachProtocolMetadata(nbackPayload, getTaskConfig('nback', 'adult'), 24)
assert.equal(nbackPayload.result_json.protocol_id, 'ultra-brief-mobile-v3')
assert.equal(nbackPayload.result_json.protocol_schema_version, 5)
assert.equal(nbackPayload.result_json.actual_trials, 24)

const trailPayload = { result_json: { raw_result: {}, trials: Array(29).fill({}) } }
attachProtocolMetadata(trailPayload, getTaskConfig('trail', 'adult'), 24)
assert.equal(trailPayload.result_json.actual_trials, 24)

for (const pageName of ['cognitive', 'stroop']) {
  const source = fs.readFileSync(path.resolve(__dirname, `../pages/${pageName}/index.js`), 'utf8')
  assert.match(source, /attachProtocolMetadata/)
}
assert.match(fs.readFileSync(path.resolve(__dirname, '../pages/nback/index.js'), 'utf8'), /finishPage\([^\n]+this\._trials\.length/)
assert.match(fs.readFileSync(path.resolve(__dirname, '../pages/trail/index.js'), 'utf8'), /finishPage\([^\n]+actualNodes/)

console.log('七项认知协议元数据一致性测试全部通过')
