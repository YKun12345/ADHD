const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const { advancePatientDataRevision } = require('../utils/session-privacy')
const WAITING_DELAYS = [800, 1000, 1200, 1400]

async function run() {
  const h = createHarness()
  try {
    const page = h.load('cognitive')
    assert.equal(page.data.totalTrials, 25)
    assert.equal(page._trials.filter(type => type === 'go').length, 20)
    h.start(page)
    page.handleTestTap(); page.handleTestTap()
    assert.equal(page._records.length, 1)
    assert.equal(page._records[0].errorType, 'false_start')
    h.advance(450)
    page._trials[1] = 'go'
    h.advance(WAITING_DELAYS[1])
    assert.equal(page.data.stimulusType, 'go')
    h.advance(326)
    page.handleTestTap(); page.handleTestTap()
    assert.equal(page._records.length, 2)
    assert.equal(page._records[1].reactionTimeMs, 326)
    assert.equal(page.data.phase, 'feedback')
    assert.equal(page.data.stimulusType, '')
    page.onUnload()

    const red = h.load('cognitive')
    h.start(red)
    red._trials[0] = 'nogo'
    h.advance(800)
    assert.equal(red.data.stimulusLabel, '停')
    h.advance(799)
    assert.equal(red._records.length, 0)
    h.advance(1)
    assert.equal(red._records[0].correct, true, '红色期间不点击是正确操作')
    red.onUnload()
    const wrongRed = h.load('cognitive')
    h.start(wrongRed); wrongRed._trials[0] = 'nogo'; h.advance(800)
    wrongRed.handleTestTap()
    assert.equal(wrongRed._records[0].errorType, 'commission')
    wrongRed.onUnload()

    const complete = h.load('cognitive', { mode: 'battery' })
    h.start(complete)
    for (let index = 0; index < 25; index++) {
      h.advance(WAITING_DELAYS[index % 4])
      if (complete._trials[index] === 'go') { h.advance(250); complete.handleTestTap(); complete.handleTestTap() }
      else h.advance(800)
      h.advance(450)
      assert.notEqual(complete.data.phase, 'break')
    }
    await h.flush()
    assert.equal(complete.data.result.total_trials, 25)
    assert.equal(complete.data.result.accuracy, 100)
    assert.equal(complete.data.syncStatus, '已同步')
    assert.equal(complete.data.nextTaskId, 'stroop')
    const payload = h.storage.cognitive_latest_results.reaction
    assert.equal(payload.result_json.protocol_id, 'continuous-mobile-v4')
    assert.equal(payload.result_json.actual_trials, 25)
    assert.ok(payload.result_json.test_run_id)
    const count = h.requests.length
    await complete._completeTest()
    assert.equal(h.requests.length, count)
    complete.onUnload()

    h.setRequest(async () => { throw new Error('offline') })
    const offline = h.load('cognitive')
    h.start(offline)
    for (let index = 0; index < 25; index++) { h.advance(WAITING_DELAYS[index % 4]); if (offline._trials[index] === 'go') offline.handleTestTap(); else h.advance(800); h.advance(450) }
    await h.flush()
    assert.equal(offline.data.syncStatus, '待同步')
    const pending = h.storage.pending_cognitive_result
    assert.equal(pending, offline._lastPayload)
    h.setRequest(async () => ({ id: 2 }))
    await offline.retrySync()
    assert.equal(h.storage.pending_cognitive_result, undefined)
    assert.equal(h.requests.at(-1).data.result_json.test_run_id, pending.result_json.test_run_id)
    offline.onUnload()

    const hidden = h.load('cognitive')
    h.start(hidden)
    const oldTimer = [...h.timers.values()][0].callback
    hidden.onHide(); hidden.onShow(); h.start(hidden)
    oldTimer()
    assert.equal(hidden.data.phase, 'waiting', '旧运行的回调不得改变新运行')
    hidden.onUnload()
    const ended = h.load('cognitive')
    h.start(ended)
    advancePatientDataRevision()
    h.advance(5000)
    assert.equal(ended._records.length, 0)
    ended.onPatientSessionEnded()
    assert.equal(h.timers.size, 0)
    assert.equal(ended.data.running, false)
    console.log('Go/No-Go连续流程、800毫秒抑制、计时器与同步测试通过')
  } finally { h.restore() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
