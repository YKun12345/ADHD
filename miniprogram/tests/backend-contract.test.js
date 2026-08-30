const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

const activeRoutes = [
  ['pages/login/index.js', '/auth/login'],
  ['pages/register/index.js', '/auth/register'],
  ['pages/home/index.js', '/patient/dashboard_status'],
  ['pages/scale/index.js', '/patient/submit_scale'],
  ['utils/cognitive-page-support.js', '/patient/submit_cognitive_test'],
  ['pages/tracking/index.js', '/patient/submit_daily_log'],
  ['pages/report/index.js', '/patient/comprehensive_report'],
  ['pages/ai-chat/index.js', '/ai/chat'],
  ['pages/server-settings/index.js', '/health']
]

for (const [file, route] of activeRoutes) {
  assert.ok(
    source(file).includes(route),
    `${file} must use B backend route ${route}`
  )
}

const apiConfig = source('utils/api-config.js')
assert.match(
  apiConfig,
  /DEFAULT_API_BASE_URL\s*=\s*['"]http:\/\/127\.0\.0\.1:8000\/api\/v1['"]/,
  'the development API base must include B backend /api/v1 prefix'
)

const expectedCognitiveTypes = [
  ['utils/gonogo-test.js', 'reaction'],
  ['utils/simple-reaction-test.js', 'simple_reaction'],
  ['utils/stroop-test.js', 'stroop'],
  ['utils/trail-test.js', 'trail'],
  ['utils/flanker-test.js', 'flanker'],
  ['utils/nback-test.js', 'nback'],
  ['utils/digit-span-test.js', 'digit']
]

for (const [file, testType] of expectedCognitiveTypes) {
  assert.match(
    source(file),
    new RegExp(`test_type\\s*:\\s*['"]${testType}['"]`),
    `${file} must emit canonical cognitive type ${testType}`
  )
}

const cognitiveSupport = source('utils/cognitive-page-support.js')
assert.match(
  cognitiveSupport,
  /request\(\{\s*url:\s*['"]\/patient\/submit_cognitive_test['"],\s*method:\s*['"]POST['"],\s*data:\s*payload\s*\}\)/,
  'all shared cognitive pages must send the complete payload to B backend'
)

console.log('A mini-program and B backend static contract tests passed')
