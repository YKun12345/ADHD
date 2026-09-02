function positiveInteger(value, fallback = 1) {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function getSectionState(completed, total, blockSize) {
  const safeTotal = positiveInteger(total)
  const safeBlockSize = positiveInteger(blockSize, safeTotal)
  const safeCompleted = Math.min(
    safeTotal,
    Math.max(0, Math.floor(Number(completed)) || 0)
  )
  const totalSections = Math.max(1, Math.ceil(safeTotal / safeBlockSize))
  const completedSections = Math.min(
    totalSections,
    Math.floor(safeCompleted / safeBlockSize)
  )
  const shouldBreak = Boolean(
    safeCompleted > 0 &&
    safeCompleted < safeTotal &&
    safeCompleted % safeBlockSize === 0
  )
  const nextSection = Math.min(
    totalSections,
    completedSections + (safeCompleted >= safeTotal ? 0 : 1)
  )

  return {
    shouldBreak,
    completed: safeCompleted,
    total: safeTotal,
    completedSections,
    totalSections,
    nextSection,
    title: shouldBreak
      ? `第 ${completedSections} 小节完成`
      : `准备开始第 ${Math.max(1, nextSection)} 小节`,
    message: shouldBreak
      ? '可以放松肩颈、眨眨眼，准备好后再继续。'
      : '保持自己的节奏，准确完成比追求速度更重要。'
  }
}

module.exports = {
  getSectionState
}
