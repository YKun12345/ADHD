function positiveInteger(value, fallback = 1) {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function getSectionState(completed, total) {
  const safeTotal = positiveInteger(total)
  const safeCompleted = Math.min(
    safeTotal,
    Math.max(0, Math.floor(Number(completed)) || 0)
  )
  return {
    shouldBreak: false,
    completed: safeCompleted,
    total: safeTotal,
    completedSections: safeCompleted >= safeTotal ? 1 : 0,
    totalSections: 1,
    nextSection: 1,
    title: safeCompleted >= safeTotal ? '测试已完成' : safeCompleted ? '测试进行中' : '准备开始测试',
    message: '保持自己的节奏，准确完成比追求速度更重要。'
  }
}

module.exports = {
  getSectionState
}
