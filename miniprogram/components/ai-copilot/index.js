const {
  getCopilotConfig,
  buildAiChatUrl
} = require('../../utils/ai-copilot')
const {
  createViewportBounds,
  movePosition,
  snapPosition,
  serializePosition,
  restorePosition,
  buildPositionStorageKey
} = require('../../utils/ai-copilot-position')
const { shouldShowPageGuide, markPageGuideSeen } = require('../../utils/guide-state')

const DRAG_THRESHOLD_PX = 6

function currentUser() {
  try { return wx.getStorageSync('current_user') || {} } catch (error) { return {} }
}

function readStoredPosition(key) {
  try { return wx.getStorageSync(key) } catch (error) { return null }
}

function writeStoredPosition(key, value) {
  try { wx.setStorageSync(key, value) } catch (error) { /* 位置记忆失败不影响助手使用。 */ }
}

function readWindowInfo(override = {}) {
  let info = {}
  try {
    if (typeof wx.getWindowInfo === 'function') info = wx.getWindowInfo() || {}
    else if (typeof wx.getSystemInfoSync === 'function') info = wx.getSystemInfoSync() || {}
  } catch (error) {
    info = {}
  }
  return { ...info, ...(override || {}) }
}

function firstTouch(event) {
  const touches = event && Array.isArray(event.touches) ? event.touches : []
  const touch = touches[0]
  if (!touch) return null
  const x = Number(touch.clientX)
  const y = Number(touch.clientY)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function releaseTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
}

Component({
  properties: {
    pageKey: {
      type: String,
      value: ''
    }
  },

  data: {
    expanded: false,
    navigating: false,
    guideBubbleVisible: false,
    config: getCopilotConfig(''),
    positionX: 0,
    positionY: 0,
    dockSide: 'right',
    guidePlacement: 'above'
  },

  lifetimes: {
    attached() {
      const config = getCopilotConfig(this.data.pageKey)
      const user = currentUser()
      this._positionStorageKey = buildPositionStorageKey(user)
      this._positionBounds = createViewportBounds(readWindowInfo())
      const position = restorePosition(
        readStoredPosition(this._positionStorageKey),
        this._positionBounds
      )
      this._applyPosition(position, { config })

      if (!shouldShowPageGuide(user, this.data.pageKey, undefined, config.version)) return
      this._showTimer = releaseTimer(setTimeout(() => {
        markPageGuideSeen(user, this.data.pageKey, undefined, config.version)
        this.setData({ guideBubbleVisible: true })
        this._hideTimer = releaseTimer(setTimeout(() => {
          this.setData({ guideBubbleVisible: false })
        }, 6000))
      }, 300))
    },
    detached() {
      clearTimeout(this._showTimer)
      clearTimeout(this._hideTimer)
    }
  },

  pageLifetimes: {
    resize(event) {
      const previousBounds = this._positionBounds || createViewportBounds(readWindowInfo())
      const saved = serializePosition({
        x: this.data.positionX,
        y: this.data.positionY
      }, previousBounds)
      const size = event && event.size && typeof event.size === 'object'
        ? event.size
        : {}
      this._positionBounds = createViewportBounds(readWindowInfo(size))
      this._applyPosition(restorePosition(saved, this._positionBounds))
    }
  },

  methods: {
    _applyPosition(position, extra = {}) {
      const bounds = this._positionBounds
      const middleX = (bounds.minX + bounds.maxX) / 2
      const middleY = (bounds.minY + bounds.maxY) / 2
      this.setData({
        ...extra,
        positionX: position.x,
        positionY: position.y,
        dockSide: position.x <= middleX ? 'left' : 'right',
        guidePlacement: position.y <= middleY ? 'below' : 'above'
      })
    },

    closeGuideBubble() {
      clearTimeout(this._hideTimer)
      this.setData({ guideBubbleVisible: false })
    },

    handleDragStart(event) {
      const touch = firstTouch(event)
      if (!touch || !this._positionBounds) return
      this._dragTouchStart = touch
      this._dragPositionStart = {
        x: this.data.positionX,
        y: this.data.positionY
      }
      this._dragMoved = false
      this.setData({
        expanded: false,
        guideBubbleVisible: false
      })
    },

    handleDragMove(event) {
      const touch = firstTouch(event)
      if (!touch || !this._dragTouchStart || !this._dragPositionStart) return
      const delta = {
        x: touch.x - this._dragTouchStart.x,
        y: touch.y - this._dragTouchStart.y
      }
      if (Math.abs(delta.x) >= DRAG_THRESHOLD_PX || Math.abs(delta.y) >= DRAG_THRESHOLD_PX) {
        this._dragMoved = true
      }
      this._applyPosition(movePosition(this._dragPositionStart, delta, this._positionBounds))
    },

    handleDragEnd() {
      if (!this._dragTouchStart || !this._dragPositionStart) return
      const moved = this._dragMoved === true
      const startPosition = this._dragPositionStart
      this._dragTouchStart = null
      this._dragPositionStart = null
      this._dragMoved = false
      if (!moved) {
        this._applyPosition(startPosition)
        return
      }

      const position = snapPosition({
        x: this.data.positionX,
        y: this.data.positionY
      }, this._positionBounds)
      this._applyPosition(position)
      writeStoredPosition(
        this._positionStorageKey,
        serializePosition(position, this._positionBounds)
      )
      this._suppressNextTap = true
    },

    togglePanel() {
      if (this._suppressNextTap) {
        this._suppressNextTap = false
        return
      }
      this.setData({
        expanded: !this.data.expanded,
        guideBubbleVisible: false
      })
    },

    closePanel() {
      this.setData({
        expanded: false
      })
    },

    openPageHelp() {
      this.navigateToAi(
        buildAiChatUrl(this.data.pageKey, 'help')
      )
    },

    openFreeQuestion() {
      this.navigateToAi(
        buildAiChatUrl(this.data.pageKey, 'free')
      )
    },

    navigateToAi(url) {
      if (this.data.navigating) return

      this.setData({
        navigating: true
      })
      wx.navigateTo({
        url,
        success: () => {
          this.setData({
            expanded: false
          })
        },
        fail: () => {
          wx.showToast({
            title: '暂时无法打开AI助手',
            icon: 'none'
          })
        },
        complete: () => {
          this.setData({
            navigating: false
          })
        }
      })
    }
  }
})
