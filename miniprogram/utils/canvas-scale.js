function requirePositiveFinite(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`)
  }
}

function createCanvasMetrics(cssWidth, cssHeight, dpr) {
  requirePositiveFinite('cssWidth', cssWidth)
  requirePositiveFinite('cssHeight', cssHeight)
  requirePositiveFinite('dpr', dpr)

  return {
    cssWidth,
    cssHeight,
    pixelWidth: Math.round(cssWidth * dpr),
    pixelHeight: Math.round(cssHeight * dpr),
    dpr
  }
}

function scalePoints(points, scale) {
  if (!Array.isArray(points)) {
    throw new TypeError('points must be an array')
  }
  requirePositiveFinite('scale', scale)

  return points.map((point) => {
    if (point === null) return null
    if (
      !point ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    ) {
      throw new TypeError('each point must contain finite x and y values')
    }
    return {
      ...point,
      x: point.x * scale,
      y: point.y * scale
    }
  })
}

function measureTextWidths(labels, measureText, fallbackCharacterWidth = 7) {
  if (!Array.isArray(labels)) throw new TypeError('labels must be an array')
  requirePositiveFinite('fallbackCharacterWidth', fallbackCharacterWidth)
  return labels.map((label) => {
    const text = String(label)
    if (typeof measureText === 'function') {
      try {
        const measurement = measureText(text)
        const width = typeof measurement === 'number'
          ? measurement
          : measurement && measurement.width
        if (Number.isFinite(width) && width >= 0) return width
      } catch (error) {}
    }
    return text.length * fallbackCharacterWidth
  })
}

function createCartesianCanvasLayout(cssWidth, cssHeight, labelWidths) {
  requirePositiveFinite('cssWidth', cssWidth)
  requirePositiveFinite('cssHeight', cssHeight)
  if (!Array.isArray(labelWidths) || !labelWidths.every((width) => Number.isFinite(width) && width >= 0)) {
    throw new TypeError('labelWidths must contain finite non-negative numbers')
  }
  const widestLabel = Math.max(0, ...labelWidths)
  const left = Math.max(26, Math.ceil(widestLabel + 15))
  const right = 18
  const top = 18
  const bottom = 24
  return {
    left,
    right,
    top,
    bottom,
    plotWidth: Math.max(1, cssWidth - left - right),
    plotHeight: Math.max(1, cssHeight - top - bottom)
  }
}

function createRadarCanvasLayout(cssWidth, cssHeight, labelWidths) {
  requirePositiveFinite('cssWidth', cssWidth)
  requirePositiveFinite('cssHeight', cssHeight)
  if (!Array.isArray(labelWidths) || labelWidths.length !== 5) {
    throw new TypeError('radar labelWidths must contain five values')
  }
  if (!labelWidths.every((width) => Number.isFinite(width) && width >= 0)) {
    throw new TypeError('radar label widths must be finite non-negative numbers')
  }

  const safeInset = 8
  const labelOffset = 24
  const labelHeight = 14
  const centerX = cssWidth / 2
  const centerY = cssHeight / 2
  let radius = Math.min(cssWidth, cssHeight) * 0.31
  labelWidths.forEach((labelWidth, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / 5
    const horizontal = Math.abs(Math.cos(angle))
    const vertical = Math.abs(Math.sin(angle))
    if (horizontal > 0.01) {
      const horizontalRoom = centerX - safeInset - labelWidth
      radius = Math.min(radius, (horizontalRoom / horizontal) - labelOffset)
    }
    if (vertical > 0.01) {
      const verticalRoom = centerY - safeInset - (labelHeight / 2)
      radius = Math.min(radius, (verticalRoom / vertical) - labelOffset)
    }
  })
  return {
    centerX,
    centerY,
    radius: Math.max(12, radius),
    safeInset,
    labelOffset
  }
}

function clampRadarLabelX(x, labelWidth, alignment, cssWidth, safeInset = 8) {
  requirePositiveFinite('cssWidth', cssWidth)
  if (!Number.isFinite(x) || !Number.isFinite(labelWidth) || labelWidth < 0) {
    throw new TypeError('radar label position and width must be finite')
  }
  if (!['left', 'right', 'center'].includes(alignment)) {
    throw new TypeError('alignment must be left, right, or center')
  }
  const minimum = alignment === 'left'
    ? safeInset
    : alignment === 'right'
      ? safeInset + labelWidth
      : safeInset + (labelWidth / 2)
  const maximum = alignment === 'left'
    ? cssWidth - safeInset - labelWidth
    : alignment === 'right'
      ? cssWidth - safeInset
      : cssWidth - safeInset - (labelWidth / 2)
  return Math.min(maximum, Math.max(minimum, x))
}

module.exports = {
  createCanvasMetrics,
  scalePoints,
  measureTextWidths,
  createCartesianCanvasLayout,
  createRadarCanvasLayout,
  clampRadarLabelX
}
