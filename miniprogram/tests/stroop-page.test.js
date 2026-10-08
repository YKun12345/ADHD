const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const { advancePatientDataRevision } = require('../utils/session-privacy')

async function run() {
  const h = createHarness()
  try {
    const page = h.load('stroop')
    h.start(page)
    assert.equal(page.data.totalTrials, 24)
    h.advance(245)
    const choice = { currentTarget: { dataset: { key: page._trials[0].colorKey, trial: 1 } } }
    page.handleAnswer(choice); page.handleAnswer(choice)
    assert.equal(page._records.length, 1)
    assert.equal(page._records[0].reactionTimeMs, 245)
    h.advance(350)
    page.handleAnswer(choice)
    assert.equal(page._records.length, 1, '迟到的上一题事件不能作答下一题')
    for (let index = 1; index < 24; index++) {
      page.handleAnswer({ currentTarget: { dataset: { key: page._trials[index].colorKey, trial: index + 1 } } })
      h.advance(350)
      assert.notEqual(page.data.phase, 'break')
    }
    await h.flush()
    assert.equal(page.data.result.total_trials, 24)
    assert.equal(page.data.result.accuracy, 100)
    assert.equal(page.data.syncStatus, '已同步')
    const payload = h.storage.cognitive_latest_results.stroop
    assert.equal(payload.result_json.actual_trials, 24)
    assert.ok(payload.result_json.test_run_id)
    const requests = h.requests.length
    await page._completeTest()
    assert.equal(h.requests.length, requests)
    page.onUnload()

    const timeout = h.load('stroop')
    h.start(timeout); h.advance(2500)
    assert.equal(timeout._records.length, 1)
    assert.equal(timeout._records[0].outcome, 'omission')
    timeout.onUnload()

    h.setRequest(async () => { throw new Error('offline') })
    const offline = h.load('stroop')
    h.start(offline)
    for (const trial of offline._trials) { offline.handleAnswer({ currentTarget: { dataset: { key: trial.colorKey } } }); h.advance(350) }
    await h.flush()
    assert.equal(offline.data.syncStatus, '待同步')
    const pending = h.storage.pending_stroop_result
    h.setRequest(async () => ({ id: 2 }))
    await offline.retrySync()
    assert.equal(offline.data.syncStatus, '已同步')
    assert.equal(h.storage.pending_stroop_result, undefined)
    assert.equal(h.requests.at(-1).data, pending)
    offline.onUnload()

    const stale = h.load('stroop')
    h.start(stale)
    const oldTimer = [...h.timers.values()][0].callback
    stale.onHide(); stale.onShow(); h.start(stale)
    oldTimer()
    assert.equal(stale._records.length, 0)
    advancePatientDataRevision()
    h.advance(3000)
    assert.equal(stale._records.length, 0)
    stale.onPatientSessionEnded()
    assert.equal(h.timers.size, 0)
    assert.equal(stale.data.running, false)
    console.log('Stroop24次连续流程、重复作答与同步测试通过')
  } finally { h.restore() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
