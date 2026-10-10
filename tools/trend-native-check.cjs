// Local WeChat DevTools verification. Storage backups stay in process memory, never on disk.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const WebSocket = process.env.WECHAT_AUTOMATION_WS_MODULE
  ? require(process.env.WECHAT_AUTOMATION_WS_MODULE)
  : require('ws')
const output = path.resolve('docs/evidence/trend-visual-verification')
fs.mkdirSync(output, { recursive: true })
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
let sequence = 0
const pending = new Map()
const socket = new WebSocket('ws://127.0.0.1:9420')
socket.on('message', (message) => {
  const response = JSON.parse(message)
  const request = pending.get(response.id)
  if (!request) return
  pending.delete(response.id)
  clearTimeout(request.timeout)
  if (response.error) request.reject(new Error(`${request.method}: ${JSON.stringify(response.error)}`))
  else request.resolve(response.result)
})
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++sequence)
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)) }, 12000)
    pending.set(id, { resolve, reject, timeout, method })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(fn, ...args) { return (await send('App.callFunction', { functionDeclaration: fn.toString(), args })).result }
async function screenshot(name) {
  const { data } = await send('App.captureScreenshot')
  fs.writeFileSync(path.join(output, name), data, 'base64')
}
async function route(url, settle = 1800) {
  await send('App.callWxMethod', { method: 'navigateTo', args: [{ url }] })
  await delay(settle)
  return await send('App.getCurrentPage')
}
async function inspectTask() {
  return evaluate(function () {
    const page = getCurrentPages().slice(-1)[0]
    const data = page.data
    return { phase: data.phase, remaining: data.instructionRemaining, ready: data.instructionReady, instructionVisible: data.instructionVisible, running: data.running, currentTrial: data.currentTrial, stimulusType: data.stimulusType, records: Array.isArray(page._records) ? page._records.length : 0 }
  })
}
async function taskScreenshots() {
  const nback = await route('/pages/nback/index', 150)
  const initial = await inspectTask()
  assert.equal(initial.ready, false)
  await send('Page.callMethod', { pageId: nback.pageId, method: 'startTest', args: [] })
  assert.equal((await inspectTask()).running, false, 'instruction gate blocks premature direct starts')
  await screenshot('native-nback-instructions-countdown.png')
  await delay(3200)
  const read = await inspectTask()
  assert.equal(read.ready, true)
  assert.equal(read.running, false, 'three seconds never starts a test automatically')
  await screenshot('native-nback-instructions-ready.png')
  await send('Page.callMethod', { pageId: nback.pageId, method: 'startTest', args: [] })
  await delay(100)
  assert.equal((await inspectTask()).phase, 'memory')
  await screenshot('native-nback-first-yellow.png')
  await delay(2200)
  assert.equal((await inspectTask()).currentTrial, 1, 'memory does not advance without a tap')
  for (let index = 0; index < 2; index++) {
    await evaluate(function () {
      const page = getCurrentPages().slice(-1)[0]
      const cell = page.data.grid.find((item) => item.active)
      page.handleCellTap({ currentTarget: { dataset: { index: cell.index, trial: page.data.currentTrial } } })
    })
    await delay(450)
  }
  assert.equal((await inspectTask()).currentTrial, 3)
  assert.equal((await inspectTask()).phase, 'testing')
  await screenshot('native-nback-third-judgment.png')
  await send('App.callWxMethod', { method: 'navigateBack', args: [{ delta: 1 }] })
  await delay(100)

  const cognitive = await route('/pages/cognitive/index', 150)
  await screenshot('native-cognitive-instructions-countdown.png')
  await delay(3200)
  // Deterministic first two trials in simulator only; never finish or submit a result.
  await evaluate(function () {
    const page = getCurrentPages().slice(-1)[0]
    page._trials[0] = 'go'; page._trials[1] = 'nogo'
  })
  await send('Page.callMethod', { pageId: cognitive.pageId, method: 'startTest', args: [] })
  await evaluate(function () { getCurrentPages().slice(-1)[0]._clearTimers() })
  await screenshot('native-cognitive-white-waiting.png')
  // Screenshot RPC can exceed the 800ms stimulus window. Freeze each visual state only for capture.
  await evaluate(function () {
    const page = getCurrentPages().slice(-1)[0]
    page._showStimulus(); page._clearTimers()
  })
  assert.equal((await inspectTask()).stimulusType, 'go')
  await screenshot('native-cognitive-full-green.png')
  await send('Page.callMethod', { pageId: cognitive.pageId, method: 'handleTestTap', args: [{ currentTarget: { dataset: { trial: 1 } } }] })
  await evaluate(function () { getCurrentPages().slice(-1)[0]._clearTimers() })
  assert.equal((await inspectTask()).phase, 'feedback')
  await screenshot('native-cognitive-white-after-go.png')
  await evaluate(function () {
    const page = getCurrentPages().slice(-1)[0]
    page.setData({ phase: 'waiting', currentTrialIndex: 1, currentTrialNumber: 2 })
    page._trialHandled = false
    page._showStimulus(); page._clearTimers()
  })
  assert.equal((await inspectTask()).stimulusType, 'nogo')
  await screenshot('native-cognitive-full-red.png')
  await evaluate(function () { getCurrentPages().slice(-1)[0]._showStimulus() })
  await delay(850)
  const noGo = await evaluate(function () {
    const page = getCurrentPages().slice(-1)[0]
    page._clearTimers()
    return { phase: page.data.phase, records: page._records.map((record) => ({ type: record.type, correct: record.correct, errorType: record.errorType })) }
  })
  assert.equal(noGo.records.length, 2)
  assert.equal(noGo.records[1].type, 'nogo')
  assert.equal(noGo.records[1].correct, true, 'no click on red is a correct operation')
  await screenshot('native-cognitive-white-after-nogo.png')
  await send('App.callWxMethod', { method: 'navigateBack', args: [{ delta: 1 }] })
  console.log('native gate and memory interactions passed; reaction visual states frozen for screenshots and no-click timeout checked; no tests submitted')
}
async function trailScreenshots() {
  const trail = await route('/pages/trail/index', 150)
  await screenshot('native-trail-instructions-countdown.png')
  await delay(3200)
  await send('Page.callMethod', { pageId: trail.pageId, method: 'startTest', args: [] })
  await delay(350)
  await send('App.callWxMethod', { method: 'pageScrollTo', args: [{ scrollTop: 140, duration: 0 }] })
  await delay(150)
  async function checkBoard(stage) {
    const result = await evaluate(function () {
      const page = getCurrentPages().slice(-1)[0]
      return new Promise((resolve) => wx.createSelectorQuery().select('#trail-board').boundingClientRect().selectAll('.trail-node').boundingClientRect().exec((rects) => resolve({ stage: page.data.stage, board: rects[0], nodes: rects[1], labels: page.data.nodes.map((node) => node.label), count: page.data.nodeCount })))
    })
    assert.equal(result.stage, stage)
    assert.equal(result.count, 30)
    assert.equal(result.nodes.length, 30)
    for (let a = 0; a < result.nodes.length; a++) {
      const node = result.nodes[a]
      assert.ok(node.width >= 39 && node.height >= 39, 'nodes keep a readable 40px target')
      assert.ok(node.left >= result.board.left - 1 && node.right <= result.board.right + 1 && node.top >= result.board.top - 1 && node.bottom <= result.board.bottom + 1, 'every node fits the actual measured board')
      for (let b = a + 1; b < result.nodes.length; b++) {
        const other = result.nodes[b]
        assert.ok(node.right <= other.left || other.right <= node.left || node.bottom <= other.top || other.bottom <= node.top, 'no native node rectangles overlap')
      }
    }
    result.nodes = result.nodes.map(({ left, right, top, bottom, width, height }) => ({ left, right, top, bottom, width, height }))
    fs.writeFileSync(path.join(output, `native-trail-${stage}-geometry.json`), JSON.stringify(result, null, 2))
  }
  await checkBoard('A')
  await screenshot('native-trail-A-30-nodes.png')
  await evaluate(function () {
    const page = getCurrentPages().slice(-1)[0]
    return new Promise((resolve) => {
      const tap = () => {
        if (page._currentIndex >= 12) { resolve(); return }
        const label = page._sequence[page._currentIndex]
        page.handleNodeTap({ currentTarget: { dataset: { label, tapToken: page.data.tapToken } } })
        setTimeout(tap, 30)
      }
      tap()
    })
  })
  await screenshot('native-trail-A-connected-path.png')
  await evaluate(function () {
    const page = getCurrentPages().slice(-1)[0]
    return new Promise((resolve) => {
      const tap = () => {
        if (page.data.phase === 'transition') { resolve(); return }
        const label = page._sequence[page._currentIndex]
        page.handleNodeTap({ currentTarget: { dataset: { label, tapToken: page.data.tapToken } } })
        setTimeout(tap, 30)
      }
      tap()
    })
  })
  await screenshot('native-trail-A-to-B-transition.png')
  await delay(2300)
  await checkBoard('B')
  await screenshot('native-trail-B-30-nodes.png')
  await send('App.callWxMethod', { method: 'navigateBack', args: [{ delta: 1 }] })
  console.log('native 30-node A/B rectangles fit and do not overlap; A completed and B began automatically; B not completed')
}
async function instructionScreenshots() {
  for (const task of ['cognitive', 'stroop', 'flanker', 'nback', 'trail', 'digit-span']) {
    await route(`/pages/${task}/index?mode=battery`, 150)
    const gate = await inspectTask()
    assert.equal(gate.instructionVisible, true, `${task} battery entry has its own gate`)
    assert.equal(gate.ready, false)
    assert.equal(gate.running, false)
    await screenshot(`native-${task}-battery-instructions.png`)
    await send('App.callWxMethod', { method: 'navigateBack', args: [{ delta: 1 }] })
    await delay(500)
  }
  console.log('native instructions shown on all six battery task entries')
}
async function trendFollowups(trend) {
  await send('App.callWxMethod', { method: 'pageScrollTo', args: [{ scrollTop: 140, duration: 0 }] })
  await delay(250)
  await screenshot('native-fixed-focus-after-scroll.png')
  await send('App.callWxMethod', { method: 'navigateTo', args: [{ url: '/pages/tracking/index' }] })
  await delay(250)
  await send('App.callWxMethod', { method: 'navigateBack', args: [{ delta: 1 }] })
  await delay(350)
  await screenshot('native-fixed-focus-after-return.png')
  await evaluate(function () {
    wx.setStorageSync('tracking_local_logs', [
      { day_index: 1, mood_tag: '4', attention_rating: 3, focus_minutes: 0, demo: true },
      { day_index: 3, mood_tag: null, attention_rating: '', focus_minutes: null, demo: true },
      { day_index: 7, mood_tag: '2', attention_rating: 5, focus_minutes: 60, demo: true },
      { day_index: 14, mood_tag: '5', attention_rating: 1, focus_minutes: 120, demo: true }
    ])
    getCurrentPages().slice(-1)[0].onShow()
  })
  for (const metric of ['mood', 'attention', 'focus']) {
    await send('Page.callMethod', { pageId: trend.pageId, method: 'selectMetric', args: [{ currentTarget: { dataset: { metric } } }] })
    await delay(180)
    await screenshot(`native-fixed-missing-${metric}.png`)
  }
  console.log('native scrolling, return and missing-date charts captured; synthetic log fixture restored in finally')
}
async function main() {
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const mode = process.argv[2] || 'baseline'
  const initialDepth = (await send('App.getPageStack')).pageStack.length
  let storageBackup
  await send('App.mockWxMethod', { method: 'request', result: { statusCode: 200, data: {} } })
  try {
    const saved = await evaluate(function () {
      const keys = wx.getStorageInfoSync().keys
      const backup = keys.map((key) => [key, wx.getStorageSync(key)])
      const info = wx.getSystemInfoSync()
      const logs = wx.getStorageSync('tracking_local_logs')
      return { backup, environment: { windowWidth: info.windowWidth, windowHeight: info.windowHeight, pixelRatio: info.pixelRatio, recordedDays: Array.isArray(logs) ? logs.length : 0 } }
    })
    storageBackup = saved.backup
    const environment = saved.environment
    console.log('native simulator', JSON.stringify(environment))
    if (mode === 'tasks') {
      await taskScreenshots()
      return
    }
    if (mode === 'trail') {
      await trailScreenshots()
      return
    }
    if (mode === 'instructions') {
      await instructionScreenshots()
      return
    }
    const trend = await route('/pages/tracking-trend/index')
    assert.equal(trend.path, 'pages/tracking-trend/index')
    for (const metric of ['mood', 'attention', 'focus']) {
      await send('Page.callMethod', { pageId: trend.pageId, method: 'selectMetric', args: [{ currentTarget: { dataset: { metric } } }] })
      await delay(350)
      await screenshot(`native-${mode}-${metric}.png`)
    }
    const bounds = await evaluate(function () {
      return new Promise((resolve) => {
        wx.createSelectorQuery().select('.chart-card').boundingClientRect().select('.chart-data-summary').boundingClientRect().select('#trackingTrendCanvas').boundingClientRect().select('#trackingTrendPlot').boundingClientRect().exec(resolve)
      })
    })
    console.log('native chart bounds', JSON.stringify(bounds))
    fs.writeFileSync(path.join(output, `native-${mode}-geometry.json`), JSON.stringify({ environment, bounds }, null, 2))
    if (mode === 'final') await trendFollowups(trend)
  } finally {
    let restored = false
    try {
      const delta = (await send('App.getPageStack')).pageStack.length - initialDepth
      if (delta > 0) await send('App.callWxMethod', { method: 'navigateBack', args: [{ delta }] })
      await delay(300)
      restored = await evaluate(function (backup) {
        if (!backup) return
        const originals = new Set(backup.map((entry) => entry[0]))
        wx.getStorageInfoSync().keys.forEach((key) => { if (!originals.has(key)) wx.removeStorageSync(key) })
        backup.forEach(([key, value]) => wx.setStorageSync(key, value))
        return backup.every(([key, value]) => JSON.stringify(wx.getStorageSync(key)) === JSON.stringify(value)) && wx.getStorageInfoSync().keys.length === backup.length
      }, storageBackup)
    } finally {
      await send('App.mockWxMethod', { method: 'request' })
    }
    assert.equal(restored, true, 'every simulator storage value and key is restored exactly')
    console.log('native verification storage restored and equality checked; request mock removed')
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 }).finally(() => socket.close())
