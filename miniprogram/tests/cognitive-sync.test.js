const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

async function run() {
  const h = createHarness()
  try {
    const { syncPayload } = require('../utils/cognitive-page-support')
    for (const failure of [false, true]) {
      const pendingRequests = []
      h.setRequest(() => new Promise((resolve, reject) => pendingRequests.push({ resolve, reject })))
      const old = h.load('nback')
      const oldPayload = { test_type: 'nback', result_json: { test_run_id: 'old', finished_at: 'old' } }
      const first = syncPayload(old, oldPayload, 'pending_nback_result')
      old.onUnload()
      let staleUpdates = 0
      old.setData = () => { staleUpdates++ }
      const current = h.load('nback')
      const newPayload = { test_type: 'nback', result_json: { test_run_id: 'new', finished_at: 'new' } }
      const second = syncPayload(current, newPayload, 'pending_nback_result')
      if (failure) pendingRequests[0].reject(new Error('offline'))
      else pendingRequests[0].resolve({ id: 1 })
      await first
      assert.equal(h.storage.pending_nback_result, newPayload, '旧请求不能清除或覆盖新运行的待同步结果')
      assert.equal(staleUpdates, 0, '请求完成后不更新已卸载的页面')
      pendingRequests[1].resolve({ id: 2 })
      await second
      assert.equal(h.storage.pending_nback_result, undefined)
      current.onUnload()
    }
    console.log('认知结果迟到请求与待同步记录隔离测试通过')
  } finally { h.restore() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
