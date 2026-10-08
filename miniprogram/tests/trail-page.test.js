const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHarness } = require('./helpers/cognitive-harness')

async function run() {
  const h = createHarness()
  try {
    const scrolls = []
    let activePage
    global.wx.pageScrollTo = (options) => scrolls.push({ ...options, stage: activePage.data.stage, phase: activePage.data.phase })
    const page = h.load('trail')
    activePage = page
    page._config = { ...page._config, partANodes: 30, partBPairs: 15 }
    if (typeof page.handleInstructionStart === 'function') h.start(page)
    else page.startTest()
    assert.equal(page.data.nodes.length, 30)
    h.advance(200)
    page.handleNodeTap({ currentTarget: { dataset: { label: '2' } } })
    assert.equal(page.data.currentIndex, 0, '点错后仍等待当前目标')
    assert.equal(page.data.errors, 1)
    page.handleNodeTap({ currentTarget: { dataset: { label: '2' } } })
    assert.equal(page.data.errors, 1, '连续误触只处理一次')
    for (const label of page._sequence.slice()) {
      h.advance(200)
      page.handleNodeTap({ currentTarget: { dataset: { label } } })
      page.handleNodeTap({ currentTarget: { dataset: { label } } })
    }
    assert.equal(page.data.phase, 'transition', 'A完成后直接显示B规则提示')
    assert.equal(scrolls.some((item) => item.phase === 'transition' && item.scrollTop === 0 && item.duration === 0), true, 'A完成后规则提示需回到顶部，不能被固定导航遮挡')
    assert.equal(page._stageResults.length, 1)
    assert.equal(page._allTaps.length, 31, '重复点击已连接节点不得重复记录')
    const stageA = { ...page._stageResults[0] }
    h.advance(1999)
    assert.equal(page.data.phase, 'transition')
    h.advance(1)
    assert.equal(page.data.stage, 'B', '无需按钮自动进入B阶段')
    assert.equal(page.data.nodes.length, 30)
    assert.equal(scrolls.some((item) => item.stage === 'B' && item.phase === 'testing' && item.scrollTop === 0), true, 'B阶段不继承A阶段滚动位置')
    assert.deepEqual(page._sequence.slice(-2), ['15', 'O'])
    assert.equal(page._stageStartedAt, Date.now(), '规则提示时间不计入B用时')
    page.handleNodeTap({ currentTarget: { dataset: { label: '1', tapToken: 'expired-stage' } } })
    assert.equal(page.data.currentIndex, 0, '旧阶段迟到的点击不得推进新阶段')
    h.advance(200)
    page.handleNodeTap({ currentTarget: { dataset: { label: 'A' } } })
    assert.equal(page.data.currentIndex, 0)
    for (const label of page._sequence.slice()) {
      h.advance(200)
      page.handleNodeTap({ currentTarget: { dataset: { label } } })
      page.handleNodeTap({ currentTarget: { dataset: { label } } })
    }
    page._completeStage()
    await h.flush()
    assert.equal(page.data.phase, 'result')
    assert.equal(scrolls.at(-1).phase, 'result', '阶段结束后结果摘要需回到顶部')
    assert.equal(h.requests.length, 1, '完成只提交一次')
    assert.equal(page.data.result.stages.length, 2)
    assert.equal(page.data.result.stages[0].nodeCount, 30)
    assert.equal(page.data.result.stages[1].nodeCount, 30)
    assert.equal(page.data.result.stages[0].errors, 1)
    assert.equal(page.data.result.stages[1].errors, 1)
    assert.equal(page.data.result.elapsed_ms, stageA.elapsedMs + page._stageResults[1].elapsedMs)
    assert.equal(h.requests[0].data.result_json.actual_trials, 60)
    page.onUnload()

    const correction = h.load('trail')
    h.start(correction)
    correction.handleNodeTap({ currentTarget: { dataset: { label: '1' } } })
    correction.handleNodeTap({ currentTarget: { dataset: { label: '1' } } })
    assert.equal(correction.data.errors, 0, '同次操作的重复事件不增加错误')
    h.advance(201)
    correction.handleNodeTap({ currentTarget: { dataset: { label: '1' } } })
    assert.equal(correction.data.errors, 1, '稍后点错已连接节点仍保留原错误记录规则')
    assert.equal(correction.data.currentIndex, 1)
    correction.onUnload()

    const interrupted = h.load('trail')
    interrupted._config = { ...interrupted._config, partANodes: 30, partBPairs: 15 }
    h.start(interrupted)
    for (const label of interrupted._sequence.slice()) {
      h.advance(200)
      interrupted.handleNodeTap({ currentTarget: { dataset: { label } } })
    }
    assert.equal(interrupted.data.phase, 'transition')
    interrupted.onHide()
    h.advance(5000)
    assert.equal(interrupted.data.phase, 'paused')
    assert.equal(interrupted.data.stage, 'A', '离开页面后旧定时器不能进入B')
    assert.equal(interrupted._context.interruptedCount, 1)
    assert.equal(h.timers.size, 0)
    interrupted.onUnload()

    const stale = h.load('trail')
    const drawCallbacks = []
    let drawCount = 0
    global.wx.createSelectorQuery = () => ({ in() { return this }, select() { return this }, boundingClientRect(callback) { drawCallbacks.push(callback); return this }, exec() {} })
    global.wx.createCanvasContext = () => ({ clearRect() {}, setStrokeStyle() {}, setLineWidth() {}, setLineCap() {}, setLineJoin() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, draw() { drawCount += 1 } })
    stale.data.phase = 'testing'
    stale.data.running = true
    stale.data.nodes = [{ order: 0, x: 10, y: 10 }, { order: 1, x: 20, y: 20 }]
    stale._drawTrailPath(1)
    stale._drawTrailPath(2)
    drawCallbacks.shift()({ width: 260, height: 400 })
    assert.equal(drawCount, 0, '旧重绘回调不能覆盖最新进度')
    drawCallbacks.shift()({ width: 260, height: 400 })
    assert.equal(drawCount, 1)
    stale._drawTrailPath(2)
    stale.onHide()
    drawCallbacks.forEach((callback) => callback({ width: 260, height: 400 }))
    assert.equal(drawCount, 1, '隐藏后迟到的绘图回调不得绘制')
    stale.onUnload()

    const template = fs.readFileSync(path.resolve(__dirname, '../pages/trail/index.wxml'), 'utf8')
    assert.equal(template.includes('continuePartB'), false)
    assert.equal(template.includes("phase === 'rest'"), false)
    assert.ok(template.includes('result.stages'), '结果需要展示A/B分别用时和错误')
    console.log('连线连续流程、误触防重、阶段计时与退出清理测试全部通过')
  } finally { h.restore() }
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
