const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHarness } = require('./helpers/cognitive-harness')

async function run() {
  const h = createHarness()
  try {
    for (const ageGroup of ['child', 'adult']) {
      for (const mode of ['single', 'battery']) {
        for (const name of ['cognitive', 'stroop', 'flanker', 'nback', 'trail', 'digit-span']) {
          const page = h.load(name, { ageGroup, mode })
          assert.equal(page.data.instructionVisible, true, `${name} 进入立即显示说明`)
          page.startTest()
          h.advance(2999)
          page.handleInstructionStart()
          assert.equal(page.data.running, false, `${name} 三秒前不能开始`)
          h.advance(1)
          assert.equal(page.data.instructionReady, true)
          assert.equal(page.data.running, false)
          page.handleInstructionStart()
          assert.equal(page.data.running, true)
          assert.equal(page.data.instructionVisible, false)
          page.onHide(); page.onUnload()
          assert.equal(h.timers.size, 0, `${name} 离开清理全部定时器`)
        }
      }
    }
    const nback = h.load('nback')
    h.start(nback)
    for (let index = 0; index < 24; index++) {
      assert.equal(nback.data.currentTrial, index + 1)
      const trial = nback._trials[index]
      const event = { currentTarget: { dataset: { index: trial.position, trial: trial.id, match: trial.isTarget } } }
      if (index < 2) {
        assert.equal(nback.data.phase, 'memory')
        h.advance(60000)
        assert.equal(nback._index, index, '记忆未点击不会超时推进')
        nback.handleAnswer(event)
        assert.equal(nback._index, index)
        nback.handleCellTap({ currentTarget: { dataset: { index: (trial.position + 1) % 9, trial: trial.id } } })
        assert.equal(nback._index, index, '仅当前黄色方格可确认')
        nback.handleCellTap(event); nback.handleCellTap(event)
      } else {
        assert.equal(nback.data.phase, 'testing')
        h.advance(60000)
        assert.equal(nback._index, index, '判断未作答不会超时推进')
        nback.handleAnswer(event); nback.handleAnswer(event)
      }
      assert.equal(nback._index, index + 1, '一次操作只推进一次')
      if (index < 23) { h.advance(400); assert.notEqual(nback.data.phase, 'break') }
    }
    await h.flush()
    const payload = h.storage.cognitive_latest_results.nback
    assert.equal(payload.result_json.actual_trials, 24)
    assert.equal(payload.result_json.raw_result.total_trials, 22)
    assert.equal(payload.result_json.raw_result.accuracy, 100)
    assert.equal(payload.result_json.trials.length, 22)
    assert.ok(payload.result_json.test_run_id)
    const requestCount = h.requests.length
    nback._completeTest()
    assert.equal(h.requests.length, requestCount, '重复完成不重复提交')
    nback.onHide(); nback.onShow()
    assert.equal(nback.data.instructionVisible, false, '完成后的结果页返回前台不能强迫重测')
    assert.equal(nback.data.phase, 'result')
    nback.onUnload()

    const interrupted = h.load('nback')
    h.advance(2000)
    interrupted.onHide()
    h.advance(60000)
    interrupted.onShow()
    interrupted.handleInstructionStart()
    assert.equal(interrupted.data.running, false, '隐藏时间不计入说明阅读')
    h.advance(3000)
    interrupted.handleInstructionStart()
    assert.equal(interrupted.data.running, true)
    interrupted.onUnload()

    const digit = h.load('digit-span')
    h.start(digit)
    for (let index = 0; index < 2; index++) {
      h.advance(3 * (800 + 250))
      assert.equal(digit.data.phase, 'recall')
      digit.submitAnswer()
      if (index === 0) h.advance(450)
    }
    assert.equal(digit.data.phase, 'direction-change', '顺背终止后先提示倒背规则')
    h.advance(1500)
    assert.equal(digit.data.directionText, '倒背')
    assert.equal(digit.data.currentTrial, 3, '提前终止后的展示轮次按实际作答计算')
    digit.onUnload()

    const flankerLate = h.load('flanker')
    h.start(flankerLate)
    const oldArrowAnswer = { currentTarget: { dataset: { direction: flankerLate._trials[0].target, trial: 1 } } }
    flankerLate.handleAnswer(oldArrowAnswer)
    h.advance(250)
    flankerLate.handleAnswer(oldArrowAnswer)
    assert.equal(flankerLate._records.length, 1, '上一题的迟到点击不能回答下一题')
    flankerLate.onUnload()

    for (const name of ['stroop', 'flanker']) {
      const page = h.load(name)
      h.start(page)
      for (let index = 0; index < 24; index++) {
        const trial = page._trials[index]
        page.handleAnswer({ currentTarget: { dataset: { key: trial.colorKey, direction: trial.target, trial: trial.id || index + 1 } } })
        if (index < 23) h.advance(name === 'stroop' ? 350 : 250)
        assert.notEqual(page.data.phase, 'break')
      }
      if (name === 'stroop') h.advance(350)
      await h.flush()
      assert.equal(page.data.result.total_trials, 24)
      page.onUnload()
    }

    for (const name of ['cognitive', 'stroop', 'flanker', 'nback', 'trail', 'digit-span']) {
      const source = fs.readFileSync(path.join(__dirname, '../pages', name, 'index.wxml'), 'utf8')
      assert.match(source, /<task-instructions/)
      assert.doesNotMatch(source, /继续下一节|开始 B 阶段|phase === 'break'|phase === 'rest'/)
    }
    const memoryView = fs.readFileSync(path.join(__dirname, '../pages/nback/index.wxml'), 'utf8')
    assert.match(memoryView, /nback-cell--memory/)
    assert.match(memoryView, /wx:if="\{\{phase === 'testing'\}\}"[^>]*class="answer-row"/)
    console.log('六项三秒阅读门禁、连续完成及两步记忆交互测试通过')
  } finally { h.restore() }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
