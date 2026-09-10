const TRIGGER_SIZE = 52
const HORIZONTAL_MARGIN = 12
const TOP_MARGIN = 8
const BOTTOM_MARGIN = 16
const NAV_BAR_HEIGHT = 44
const STORAGE_PREFIX = 'ai_copilot_position_v1'

function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function createViewportBounds(info = {}) {
  const width = Math.max(TRIGGER_SIZE + HORIZONTAL_MARGIN * 2, finiteNumber(info.windowWidth, 375))
  const height = Math.max(TRIGGER_SIZE + TOP_MARGIN + BOTTOM_MARGIN, finiteNumber(info.windowHeight, 667))
  const safeArea = info.safeArea && typeof info.safeArea === 'object'
    ? info.safeArea
    : {}
  const statusBarHeight = Math.max(0, finiteNumber(info.statusBarHeight, 0))
  const safeTop = Math.max(statusBarHeight, finiteNumber(safeArea.top, statusBarHeight))
  const safeBottom = Math.min(height, finiteNumber(safeArea.bottom, height))
  const minX = HORIZONTAL_MARGIN
  const maxX = Math.max(minX, width - TRIGGER_SIZE - HORIZONTAL_MARGIN)
  const minY = Math.min(height - TRIGGER_SIZE, safeTop + NAV_BAR_HEIGHT + TOP_MARGIN)
  const maxY = Math.max(minY, safeBottom - TRIGGER_SIZE - BOTTOM_MARGIN)

  return {
    minX: Math.round(minX),
    maxX: Math.round(maxX),
    minY: Math.round(minY),
    maxY: Math.round(maxY),
    width: Math.round(width),
    height: Math.round(height)
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, minimum)))
}

function clampPosition(position = {}, bounds) {
  return {
    x: Math.round(clamp(position.x, bounds.minX, bounds.maxX)),
    y: Math.round(clamp(position.y, bounds.minY, bounds.maxY))
  }
}

function movePosition(start = {}, delta = {}, bounds) {
  return clampPosition({
    x: finiteNumber(start.x, bounds.maxX) + finiteNumber(delta.x, 0),
    y: finiteNumber(start.y, bounds.maxY) + finiteNumber(delta.y, 0)
  }, bounds)
}

function snapPosition(position = {}, bounds) {
  const clamped = clampPosition(position, bounds)
  const middle = (bounds.minX + bounds.maxX) / 2
  return {
    x: clamped.x <= middle ? bounds.minX : bounds.maxX,
    y: clamped.y
  }
}

function serializePosition(position = {}, bounds) {
  const snapped = snapPosition(position, bounds)
  const availableHeight = bounds.maxY - bounds.minY
  const rawRatio = availableHeight > 0
    ? (snapped.y - bounds.minY) / availableHeight
    : 1
  return {
    version: 1,
    side: snapped.x === bounds.minX ? 'left' : 'right',
    yRatio: Number(clamp(rawRatio, 0, 1).toFixed(4))
  }
}

function restorePosition(saved, bounds) {
  const valid = saved &&
    saved.version === 1 &&
    (saved.side === 'left' || saved.side === 'right') &&
    Number.isFinite(Number(saved.yRatio)) &&
    Number(saved.yRatio) >= 0 &&
    Number(saved.yRatio) <= 1

  if (!valid) return { x: bounds.maxX, y: bounds.maxY }

  return {
    x: saved.side === 'left' ? bounds.minX : bounds.maxX,
    y: Math.round(bounds.minY + (bounds.maxY - bounds.minY) * Number(saved.yRatio))
  }
}

function buildPositionStorageKey(user = {}) {
  const role = user.role === 'researcher' ? 'researcher' : 'patient'
  const id = Number(user.id)
  const identity = Number.isInteger(id) && id > 0 ? id : 'anonymous'
  return `${STORAGE_PREFIX}:${role}:${identity}`
}

module.exports = {
  createViewportBounds,
  clampPosition,
  movePosition,
  snapPosition,
  serializePosition,
  restorePosition,
  buildPositionStorageKey
}
