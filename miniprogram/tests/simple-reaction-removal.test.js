const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
const { TASK_ORDER } = require('../utils/cognitive-config')
const {
  TEST_DEFINITIONS,
  buildCognitiveSummary
} = require('../utils/cognitive-results')

assert.equal(app.pages.includes('pages/simple-reaction/index'), false)
assert.deepEqual(TASK_ORDER, [
  'reaction',
  'stroop',
  'flanker',
  'nback',
  'trail',
  'digit'
])
assert.equal(TASK_ORDER.includes('simple_reaction'), false)
assert.equal(
  TEST_DEFINITIONS.some((item) => item.id === 'simple_reaction'),
  false
)
assert.equal(buildCognitiveSummary({}).totalCount, 6)
assert.equal(fs.existsSync(path.join(ROOT, 'pages', 'simple-reaction')), false)
assert.equal(fs.existsSync(path.join(ROOT, 'utils', 'simple-reaction-test.js')), false)

console.log('简单反应时任务移除契约测试全部通过')
