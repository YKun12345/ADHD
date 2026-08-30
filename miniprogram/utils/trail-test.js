function buildTrailSequence(stage, size) {
  const count = Math.max(0, Math.floor(size))
  if (stage === 'B') {
    const values = []
    for (let index = 1; index <= count; index += 1) {
      values.push(String(index), String.fromCharCode(64 + index))
    }
    return values
  }
  return Array.from({ length: count }, (_, index) => String(index + 1))
}

function seeded(seed) {
  let value = (Number(seed) || 1) >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 4294967296
  }
}

function createTrailLayout(sequence, seed = 1) {
  const random = seeded(seed)
  const columns = 5
  const rows = Math.max(2, Math.ceil(sequence.length / columns))
  const cells = Array.from({ length: columns * rows }, (_, index) => index)
  for (let index = cells.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[cells[index], cells[target]] = [cells[target], cells[index]]
  }
  return sequence.map((label, index) => {
    const cell = cells[index]
    const column = cell % columns
    const row = Math.floor(cell / columns)
    return {
      id: `${label}-${index}`,
      label,
      x: Math.round(8 + (column / Math.max(1, columns - 1)) * 84),
      y: Math.round(8 + (row / Math.max(1, rows - 1)) * 84),
      order: index
    }
  })
}

function evaluateTrailTap(sequence, currentIndex, label) {
  const correct = sequence[currentIndex] === String(label)
  return {
    correct,
    nextIndex: correct ? Math.min(sequence.length, currentIndex + 1) : currentIndex,
    completed: correct && currentIndex + 1 >= sequence.length
  }
}

function summarizeTrailStages(stages) {
  const safeStages = Array.isArray(stages) ? stages : []
  const errors = safeStages.reduce((sum, stage) => sum + (Number(stage.errors) || 0), 0)
  const nodeCount = safeStages.reduce((sum, stage) => sum + (Number(stage.nodeCount) || 0), 0)
  return {
    elapsed_ms: safeStages.reduce((sum, stage) => sum + (Number(stage.elapsedMs) || 0), 0),
    errors,
    accuracy: nodeCount ? Math.round((nodeCount / (nodeCount + errors)) * 100) : 0,
    completed: safeStages.length > 0 && safeStages.every((stage) => stage.completed),
    stages: safeStages.map((stage) => ({ ...stage }))
  }
}

function buildTrailPayload(summary, trials, context = {}, finishedAt = new Date().toISOString()) {
  const flags = summary.completed ? [] : ['incomplete']
  return {
    test_type: 'trail',
    result_json: {
      schema_version: 2,
      test_name: '连线测试',
      status_text: summary.completed ? '已完成' : '未完整完成',
      age_group: context.ageGroup === 'adult' ? 'adult' : 'child',
      mode: context.mode === 'battery' ? 'battery' : 'single',
      summary: `总用时 ${(summary.elapsed_ms / 1000).toFixed(1)} 秒，错误 ${summary.errors} 次`,
      metrics: [
        { label: '总用时', value: `${summary.elapsed_ms} ms` },
        { label: '错误', value: String(summary.errors) }
      ],
      raw_result: summary,
      quality: { valid: flags.length === 0, flags, interrupted_count: Number(context.interruptedCount) || 0, practice_attempts: Number(context.practiceAttempts) || 1 },
      trials: Array.isArray(trials) ? trials : [],
      finished_at: finishedAt
    }
  }
}

module.exports = { buildTrailSequence, createTrailLayout, evaluateTrailTap, summarizeTrailStages, buildTrailPayload }
