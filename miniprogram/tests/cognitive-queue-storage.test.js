const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')

test('an actual completed-page storage failure retains the volatile result and offers retry without claiming persistence', async () => {
  const h = createHarness()
  try {
    const page = h.load('flanker'); page._context.testRunId = 'synthetic-quota-run'
    const { finishPage } = require('../utils/cognitive-page-support')
    const write = wx.setStorageSync
    wx.setStorageSync = () => { throw new Error('synthetic device quota exceeded') }
    const payload = { test_type: 'flanker', result_json: { raw_result: { accuracy: 50 }, trials: [] } }
    assert.equal(await finishPage(page, 'flanker', payload, 'pending_flanker_result'), false)
    assert.equal(page.data.phase, 'result')
    assert.equal(page.data.result.accuracy, 50)
    assert.equal(page.data.canRetrySync, true)
    assert.notEqual(page.data.syncStatus, '待同步')
    assert.equal(h.requests.length, 0)
    wx.setStorageSync = write
    assert.equal(await page.retrySync(), true)
    assert.equal(h.requests.at(-1).data.result_json.test_run_id, 'synthetic-quota-run')
  } finally { h.restore() }
})
