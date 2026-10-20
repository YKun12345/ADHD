const { buildGoNoGoTrials } = require('./gonogo-test')
const { buildStroopTrials } = require('./stroop-test')

function preparePractice(page, task) {
  const config = page._formalConfig
  page._config = { ...config, formalTrials: config.practiceTrials, partANodes: config.practiceNodes,
    ...(task === 'digit' ? { maxSpan: config.minSpan, trialsPerSpan: 1 } : {}) }
  if (task === 'reaction') page._trials = buildGoNoGoTrials(config.practiceTrials)
  if (task === 'stroop') page._trials = buildStroopTrials(config.practiceTrials, config.congruentRatio)
  page._completionSaved = false
  page.setData({ practiceStage: true, practicePassed: false, practiceFinished: false, practiceStatus: '当前为练习，练习记录与正式结果分别保存。', totalTrials: task === 'digit' ? 2 : config.practiceTrials || config.practiceNodes })
}
function finishPractice(page, task, payload) {
  page._completionSaved = true
  const trials = payload.result_json.trials
  const scored = trials.filter(row => row.scored !== false)
  const accuracy = task === 'trail' ? 100 * page._formalConfig.practiceNodes / trials.length : 100 * scored.filter(row => row.correct === true).length / scored.length
  const passed = Number.isFinite(accuracy) && Math.round(accuracy) >= page._formalConfig.practicePassPercent
  page._practiceRecords.push({ attempt: page._practiceRecords.length + 1, trials: JSON.parse(JSON.stringify(trials)) })
  page._context.practiceAttempts = page._practiceRecords.length
  page.setData({ running: false, phase: 'practice-result', practiceFinished: true, practicePassed: passed,
    practiceStatus: passed ? '练习已通过，可以开始正式测试。' : page._practiceRecords.length < page._formalConfig.maxPracticeAttempts ? '练习未通过，可以重新练习。' : '本次练习未通过，请返回本轮评估后再安排新尝试。' })
  return false
}
function prepareFormal(page, task) {
  page._config = page._formalConfig
  if (task === 'reaction') page._trials = buildGoNoGoTrials(page._config.formalTrials)
  if (task === 'stroop') page._trials = buildStroopTrials(page._config.formalTrials, page._config.congruentRatio)
  page._completionSaved = false
  page.setData({ practiceStage: false, practiceFinished: false, practiceStatus: '', totalTrials: page._config.formalTrials || (task === 'digit' ? (page._config.maxSpan - page._config.minSpan + 1) * page._config.trialsPerSpan * 2 : 0) })
}
module.exports = { preparePractice, finishPractice, prepareFormal }
