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

function createTrailLayout(sequence, seed = 1, board) {
  const random = seeded(seed)
  const width = board && Number(board.width) > 0 ? Number(board.width) : 300
  const height = board && Number(board.height) > 0 ? Number(board.height) : 380
  const nodeSize = board && Number(board.nodeSize) > 0 ? Number(board.nodeSize) : 40
  const gap = board && Number(board.gap) >= 0 ? Number(board.gap) : 10
  let columns = 5
  let rows = Math.max(2, Math.ceil(sequence.length / columns))
  if (board && sequence.length) {
    const maxColumns = Math.max(1, Math.min(sequence.length, Math.floor((width + gap) / (nodeSize + gap))))
    let bestSpacingDifference = Infinity
    for (let candidate = 1; candidate <= maxColumns; candidate += 1) {
      const candidateRows = Math.ceil(sequence.length / candidate)
      if (candidateRows * nodeSize + (candidateRows - 1) * gap > height) continue
      const horizontalSpacing = candidate > 1 ? (width - nodeSize) / (candidate - 1) : width
      const verticalSpacing = candidateRows > 1 ? (height - nodeSize) / (candidateRows - 1) : height
      const difference = Math.abs(horizontalSpacing - verticalSpacing)
      if (difference < bestSpacingDifference) {
        columns = candidate
        rows = candidateRows
        bestSpacingDifference = difference
      }
    }
    if (!Number.isFinite(bestSpacingDifference)) throw new RangeError('连线区域不足以容纳清晰且不重叠的节点')
  }
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
      x: board
        ? Number(((columns === 1 ? width / 2 : nodeSize / 2 + column / (columns - 1) * (width - nodeSize)) / width * 100).toFixed(5))
        : Math.round(8 + (column / Math.max(1, columns - 1)) * 84),
      y: board
        ? Number(((rows === 1 ? height / 2 : nodeSize / 2 + row / (rows - 1) * (height - nodeSize)) / height * 100).toFixed(5))
        : Math.round(8 + (row / Math.max(1, rows - 1)) * 84),
      size: nodeSize,
      order: index
    }
  })
}

function createRandomTrailLayout(sequence, random = Math.random, board) {
  const sample = Number(random())
  const normalized = Number.isFinite(sample)
    ? Math.max(0, Math.min(0.999999999, sample))
    : 0
  const seed = Math.floor(normalized * 4294967295) + 1
  return createTrailLayout(sequence, seed, board)
}

function buildTrailPath(layout, completedCount) {
  const nodes = Array.isArray(layout)
    ? layout.slice().sort((left, right) => left.order - right.order)
    : []
  const count = Math.max(0, Math.min(nodes.length, Math.floor(Number(completedCount) || 0)))
  return nodes.slice(0, count).reduce((segments, node, index, completedNodes) => {
    if (index > 0) segments.push({ from: completedNodes[index - 1], to: node })
    return segments
  }, [])
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
  const stages = Array.isArray(summary.stages) ? summary.stages : []
  const stageMetrics = stages.flatMap((stage) => [
    { label: `${stage.stage}阶段用时`, value: `${(stage.elapsedMs / 1000).toFixed(1)} 秒` },
    { label: `${stage.stage}阶段错误`, value: String(stage.errors) }
  ])
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
        { label: '错误', value: String(summary.errors) },
        ...stageMetrics
      ],
      raw_result: summary,
      quality: { valid: flags.length === 0, flags, interrupted_count: Number(context.interruptedCount) || 0, practice_attempts: Number(context.practiceAttempts) || 1 },
      trials: Array.isArray(trials) ? trials : [],
      finished_at: finishedAt
    }
  }
}

module.exports = {
  buildTrailSequence,
  createTrailLayout,
  createRandomTrailLayout,
  buildTrailPath,
  evaluateTrailTap,
  summarizeTrailStages,
  buildTrailPayload
}
