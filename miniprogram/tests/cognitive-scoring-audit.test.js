const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const { COLORS } = require('../utils/stroop-test')
const { buildNBackTrials, evaluateNBackAnswer, summarizeNBackTrials } = require('../utils/nback-test')

function tap(dataset) { return { currentTarget: { dataset } } }
function presentDigits(h, page) {
  const shown = []
  while (page.data.phase === 'presenting') {
    if (page.data.shownDigit !== '') shown.push(Number(page.data.shownDigit))
    h.advance(page._config.digitDurationMs + page._config.gapMs)
  }
  assert.equal(page.data.phase, 'recall')
  return page.data.directionText === '倒背' ? shown.reverse() : shown
}
function answerDigits(page, digits) {
  digits.forEach((digit) => page.handleDigitTap(tap({ digit: String(digit), trial: page.data.currentTrial })))
  page.submitAnswer(tap({ trial: page.data.currentTrial }))
}

async function run() {
  const h = createHarness()
  try {
    // A delayed event from the prior round must never alter the next answer.
    const digit = h.load('digit-span')
    h.start(digit)
    answerDigits(digit, presentDigits(h, digit))
    h.advance(450)
    presentDigits(h, digit)
    digit.handleDigitTap(tap({ digit: '0', trial: 1 }))
    assert.deepEqual(digit.data.answer, [], '上一轮的迟到数字不能写入本轮')
    digit.handleDigitTap(tap({ digit: '7', trial: 2 }))
    digit.handleDelete(tap({ trial: 1 }))
    assert.deepEqual(digit.data.answer, [7], '上一轮的迟到删除不能清空本轮')
    digit.submitAnswer(tap({ trial: 1 }))
    assert.equal(digit._records.length, 1, '上一轮的迟到提交不能提交本轮')
    digit.handleDelete(tap({ trial: 2 }))
    assert.deepEqual(digit.data.answer, [])
    digit.handleDigitTap(tap({ digit: 'invalid', trial: 2 }))
    assert.deepEqual(digit.data.answer, [], '非法数字不能进入答案')
    digit.onUnload()

    for (const ageGroup of ['child', 'adult']) {
      for (const mode of ['single', 'battery']) {
        for (const name of ['cognitive', 'stroop', 'flanker', 'nback', 'trail', 'digit-span']) {
          const page = h.load(name, { ageGroup, mode })
          h.start(page)
          if (name === 'cognitive') {
            for (let index = 0; index < page.data.totalTrials; index++) {
              h.advance([800, 1000, 1200, 1400][index % 4])
              assert.equal(page.data.phase, 'stimulus')
              if (page.data.stimulusType === 'go') {
                h.advance(100)
                const event = tap({ trial: page.data.currentTrialNumber })
                page.handleTestTap(event); page.handleTestTap(event)
              } else h.advance(page._config.responseWindowMs)
              h.advance(450)
            }
          } else if (name === 'stroop') {
            for (let index = 0; index < page.data.totalTrials; index++) {
              const color = COLORS.find((entry) => entry.hex === page.data.currentColorHex)
              h.advance(100)
              const event = tap({ key: color.key, trial: page.data.currentTrialNumber })
              page.handleAnswer(event); page.handleAnswer(event)
              h.advance(350)
            }
          } else if (name === 'flanker') {
            for (let index = 0; index < page.data.totalTrials; index++) {
              const arrow = page.data.stimulusText.trim().split(/\s+/)[2]
              h.advance(100)
              const event = tap({ direction: arrow === '←' ? 'left' : 'right', trial: page.data.currentTrial })
              page.handleAnswer(event); page.handleAnswer(event)
              if (page.data.running) h.advance(250)
            }
          } else if (name === 'nback') {
            const positions = []
            let lastEvent
            for (let index = 0; index < page.data.totalTrials; index++) {
              const cell = page.data.grid.find((entry) => entry.active)
              positions.push(cell.index)
              if (index < 2) {
                page.handleCellTap(tap({ index: cell.index, trial: page.data.currentTrial }))
              } else {
                if (lastEvent) page.handleAnswer(lastEvent)
                assert.equal(page._records.length, index - 2, '迟到点击不能回答下一题')
                h.advance(100)
                const event = tap({ match: String(cell.index === positions[index - 2]), trial: page.data.currentTrial })
                page.handleAnswer(event); page.handleAnswer(event)
                lastEvent = event
              }
              if (page.data.running) h.advance(400)
            }
            assert.equal(page.data.result.total_trials, 22)
            assert.equal(page.data.result.correct_trials, 22)
            assert.equal(page.data.result.misses, 0)
            assert.equal(page.data.result.false_alarms, 0)
          } else if (name === 'trail') {
            for (let stage = 0; stage < 2; stage++) {
              const labels = stage === 0
                ? Array.from({ length: 30 }, (_, index) => String(index + 1))
                : Array.from({ length: 15 }, (_, index) => [String(index + 1), String.fromCharCode(65 + index)]).flat()
              labels.forEach((label) => { h.advance(50); page.handleNodeTap(tap({ label, tapToken: page.data.tapToken })) })
              if (stage === 0) h.advance(2000)
            }
            assert.equal(page.data.result.errors, 0)
            assert.equal(page.data.result.stages.length, 2)
            assert.equal(page.data.result.elapsed_ms, 3000)
          } else {
            let rounds = 0
            while (page.data.running) {
              if (page.data.phase === 'direction-change') h.advance(1500)
              answerDigits(page, presentDigits(h, page))
              rounds++
              if (page.data.phase === 'feedback') h.advance(450)
            }
            assert.equal(page.data.result.total_trials, rounds)
            assert.equal(page.data.result.forward_max_span, page._config.maxSpan)
            assert.equal(page.data.result.backward_max_span, page._config.maxSpan)
          }
          await h.flush()
          assert.equal(page.data.phase, 'result', name + ' completes')
          if (name !== 'trail') assert.equal(page.data.result.accuracy, 100, name + ' all correct is 100%')
          const payload = h.requests[h.requests.length - 1].data
          assert.deepEqual(payload.result_json.raw_result, page.data.result, '显示与提交结果一致')
          const saved = h.storage.cognitive_latest_results[payload.test_type]
          assert.deepEqual(saved.result_json.raw_result, page.data.result, '本地缓存与显示一致')
          assert.equal(payload.result_json.age_group, ageGroup)
          assert.equal(payload.result_json.mode, mode)
          assert.equal(payload.result_json.actual_trials, name === 'trail' ? 60 : page.data.totalTrials)
          page.onUnload()
        }
      }
    }

    // The memory preparation trials must not become errors in a full record list.
    const memoryTrials = buildNBackTrials(24, () => 0.42)
    const memoryRecords = memoryTrials.map((trial) => evaluateNBackAnswer(trial, trial.scored ? trial.isTarget : null, 100))
    const perfect = summarizeNBackTrials(memoryRecords)
    assert.equal(perfect.total_trials, 22)
    assert.equal(perfect.correct_trials, 22)
    assert.equal(perfect.accuracy, 100)
    let invertedTargets = 0
    let invertedOthers = 0
    const mixed = memoryTrials.slice(2).map((trial) => {
      const invert = trial.isTarget ? invertedTargets++ < 4 : invertedOthers++ < 4
      return evaluateNBackAnswer(trial, invert ? !trial.isTarget : trial.isTarget, 100)
    })
    const screenshot = summarizeNBackTrials(mixed)
    assert.equal(screenshot.accuracy, 64)
    assert.equal(screenshot.correct_trials, 14)
    assert.equal(screenshot.hits, 3)
    assert.equal(screenshot.misses, 4)
    assert.equal(screenshot.false_alarms, 4)
    assert.equal(screenshot.correct_rejections, 11)
    assert.equal(summarizeNBackTrials(memoryTrials.slice(2).map((trial) => evaluateNBackAnswer(trial, !trial.isTarget, 100))).accuracy, 0)
    console.log('六项任务可见刺激全对、儿童/成人、单项/完整评估、计分一致性及迟到输入检查通过')
  } finally { h.restore() }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
