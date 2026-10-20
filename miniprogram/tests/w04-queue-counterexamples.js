// Explicit W04 preflight, excluded from the default *.test.js W02 regression.
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

async function run() {
  const h = createHarness()
  try {
    h.setRequest(async () => { throw new Error('synthetic offline') })
    const { syncPayload } = require('../utils/cognitive-page-support')
    for (const runId of ['synthetic-offline-run-A', 'synthetic-offline-run-B']) {
      const page = h.load('flanker')
      const payload = {
        test_type: 'flanker',
        result_json: { test_run_id: runId, finished_at: 'synthetic', raw_result: { accuracy: 50 } }
      }
      assert.equal(await syncPayload(page, payload, 'pending_flanker_result'), false)
      assert.equal(page.data.syncStatus, '待同步')
      page.onUnload()
    }
    // Volatile page objects cannot recover after closure. Both unacknowledged
    // immutable results must still exist in durable storage, regardless of its
    // eventual queue representation or per-run namespace.
    const persisted = JSON.stringify(h.storage)
    assert.ok(persisted.includes('synthetic-offline-run-B'))
    assert.ok(persisted.includes('synthetic-offline-run-A'), 'Second offline attempt overwrote the first unacknowledged result')
  } finally {
    h.restore()
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
