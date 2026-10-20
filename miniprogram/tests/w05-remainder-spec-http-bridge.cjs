// Run the existing real HTTP/worker/controller scenarios independently while
// redirecting only their two fixed evidence output filenames. Production paths,
// transport, scenario assertions and synthetic server setup remain unchanged.
const fs = require('node:fs')
const path = require('node:path')
const evidence = path.resolve(__dirname, '../../docs/evidence')
const redirects = new Map([
  [path.join(evidence, 'w05-attention-actions-actual-http-receipt.json'), path.join(evidence, 'w05-remainder-spec-f03-http-receipt.json')],
  [path.join(evidence, 'w05-attention-http-server.txt'), path.join(evidence, 'w05-remainder-spec-f03-http-server.txt')]
])
const write = fs.writeFileSync
fs.writeFileSync = function (filename, ...arguments_) {
  const redirected = typeof filename === 'string' ? redirects.get(path.resolve(filename)) : null
  return write.call(this, redirected || filename, ...arguments_)
}
process.env.W05_VERIFY_SHARED_WEB = 'false'
require('./care-attention-integration.test.js')
