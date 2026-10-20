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
const { pageHelpSteps } = require('../../utils/page-help-steps')

const DRAG_THRESHOLD_PX = 6
const PET_REPLIES = {
  blink: '眨眨眼，我在这里陪你。',
  tilt: '我在听，你慢慢说。',
  wave: '向你挥挥手，你好呀！'
}

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
    patientId: { type: Number, value: 0 },
    assessmentId: { type: Number, value: 0 },
    cycleId: { type: Number, value: 0 },
    paused: { type: Boolean, value: false },
    reducedMotion: { type: Boolean, value: false },
    bottomInset: { type: Number, value: 0 },
    localHelpOnly: { type: Boolean, value: false },
    pageKey: {
      type: String,
      value: ''
    }
  },

  data: {
    expanded: false,
    navigating: false,
    inlineHelpVisible: false,
    helpSteps: [],
    guideBubbleVisible: false,
    petFeedback: '',
    config: getCopilotConfig(''),
    positionX: 0,
    positionY: 0,
    dockSide: 'right',
    guidePlacement: 'above'
  },

  observers: {
    paused(value) {
      if (value && this._attached) this._stopAssistantFeedback()
    },
    reducedMotion(value) {
      if (!value || !this._attached) return
      this._clearGuideTimers()
      this.setData({ guideBubbleVisible: false })
    }
  },

  lifetimes: {
    attached() {
      this._attached = true
      this._pageVisible = true
      this._guideEpoch = (this._guideEpoch || 0) + 1
      const config = getCopilotConfig(this.data.pageKey)
      const user = currentUser()
      this._positionStorageKey = buildPositionStorageKey(user)
      this._positionBounds = createViewportBounds(readWindowInfo({ bottomReserved: this.data.bottomInset }))
      const position = restorePosition(
        readStoredPosition(this._positionStorageKey),
        this._positionBounds
      )
      this._applyPosition(position, { config })

      if (!this._canInteract() || this.data.reducedMotion || !shouldShowPageGuide(user, this.data.pageKey, undefined, config.version)) return
      const epoch = this._guideEpoch
      this._showTimer = releaseTimer(setTimeout(() => {
        if (!this._attached || !this._canInteract() || this.data.reducedMotion || epoch !== this._guideEpoch) return
        this._showTimer = null
        markPageGuideSeen(user, this.data.pageKey, undefined, config.version)
        this.setData({ guideBubbleVisible: true })
        this._hideTimer = releaseTimer(setTimeout(() => {
          if (!this._attached || !this._canInteract() || epoch !== this._guideEpoch) return
          this._hideTimer = null
          this.setData({ guideBubbleVisible: false })
        }, 6000))
      }, 300))
    },
    detached() {
      this._attached = false
      this._pageVisible = false
      this._clearGuideTimers()
      this._navigationEpoch = (this._navigationEpoch || 0) + 1
      this.handleDragCancel()
    }
  },

  pageLifetimes: {
    show() {
      if (!this._attached) return
      this._pageVisible = true
    },
    hide() {
      this._pageVisible = false
      this._stopAssistantFeedback()
    },
    resize(event) {
      if (!this._attached) return
      const previousBounds = this._positionBounds || createViewportBounds(readWindowInfo())
      const saved = serializePosition({
        x: this.data.positionX,
        y: this.data.positionY
      }, previousBounds)
      const size = event && event.size && typeof event.size === 'object'
        ? event.size
        : {}
      this._positionBounds = createViewportBounds(readWindowInfo({ ...size, bottomReserved: this.data.bottomInset }))
      this._applyPosition(restorePosition(saved, this._positionBounds))
    }
  },

  methods: {
    _canInteract() {
      if (this._attached === false || this._pageVisible === false || this.data.paused || this.data.navigating) return false
      let source
      try { source = typeof getCurrentPages === 'function' ? getCurrentPages().slice(-1)[0] : null } catch (_) { source = null }
      return !source?.data?.running
    },

    _clearGuideTimers() {
      clearTimeout(this._showTimer)
      clearTimeout(this._hideTimer)
      this._showTimer = null
      this._hideTimer = null
      this._guideEpoch = (this._guideEpoch || 0) + 1
    },

    _stopAssistantFeedback() {
      this._clearGuideTimers()
      this._navigationEpoch = (this._navigationEpoch || 0) + 1
      this.handleDragCancel()
      if (!this._attached) return
      this.setData({ expanded: false, navigating: false, inlineHelpVisible: false, helpSteps: [], guideBubbleVisible: false, petFeedback: '' })
    },

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
      if (!this._attached) return
      this._clearGuideTimers()
      this.setData({ guideBubbleVisible: false })
    },

    handleDragStart(event) {
      if (!this._canInteract()) return
      const touch = firstTouch(event)
      if (!touch || !this._positionBounds) return
      this._clearGuideTimers()
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
      if (!this._canInteract()) return
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
      if (!this._canInteract()) {
        this.handleDragCancel()
        return
      }
      const moved = this._dragMoved === true
      const startPosition = this._dragPositionStart
      this._dragTouchStart = null
      this._dragPositionStart = null
      this._dragMoved = false
      if (!moved) {
        this._applyPosition(startPosition)
        this.togglePanel()
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
    },

    handleDragCancel() {
      this._dragTouchStart = null
      this._dragPositionStart = null
      this._dragMoved = false
    },

    togglePanel() {
      if (!this._canInteract()) return
      this._clearGuideTimers()
      const epoch = this._guideEpoch
      this.setData({
        expanded: !this.data.expanded,
        guideBubbleVisible: false,
        petFeedback: ''
      }, () => {
        if (!this._canInteract() || !this.data.expanded || epoch !== this._guideEpoch) return
        const pet = typeof this.selectComponent === 'function' ? this.selectComponent('#copilot-panel-mascot') : null
        if (pet && typeof pet.onInteract === 'function') pet.onInteract()
      })
    },

    closePanel() {
      if (!this._attached) return
      this._clearGuideTimers()
      this.setData({
        expanded: false, inlineHelpVisible: false, petFeedback: ''
      })
    },

    handlePetInteract(event) {
      if (!this._canInteract() || !this.data.expanded) return
      const detail = event && event.detail
      if (!detail || !detail.accepted || detail.state !== 'idle' || !PET_REPLIES[detail.reaction]) return
      this.setData({ petFeedback: PET_REPLIES[detail.reaction] })
    },

    toggleReducedMotion() {
      if (!this._canInteract()) return
      this._clearGuideTimers()
      this.setData({ reducedMotion: !this.data.reducedMotion, guideBubbleVisible: false })
    },

    openPageHelp() {
      if (!this._canInteract()) return false
      let source
      try { source = typeof getCurrentPages === 'function' ? getCurrentPages().slice(-1)[0] : null } catch (_) { source = null }
      this.setData({ expanded: true, inlineHelpVisible: true, helpSteps: source?.data?.running
        ? ['当前正在计时作答，请先按已有说明完成，或按页面规则结束本次尝试。', '结束后我可以再解释规则、练习方法和下一步。']
        : pageHelpSteps(this.data.pageKey, this.data.config) })
      return true
    },

    openFreeQuestion() {
      this.navigateToAi(
        buildAiChatUrl(this.data.pageKey, 'free')
      )
    },

    navigateToAi(url) {
      if (this._attached === false || this.data.navigating || this.data.paused || this._pageVisible === false) return false
      // Newly supported auth/authorization forms keep help in place. Their
      // onHide clears sensitive input and cannot safely restore consent choices.
      if (this.data.localHelpOnly) { this.openPageHelp(); return false }
      let source
      try { source = typeof getCurrentPages === 'function' ? getCurrentPages().slice(-1)[0] : null } catch (_) { source = null }
      if (source?.data?.running) { wx.showToast({ title: '请先完成或按页面规则结束本次作答，再打开聊天', icon: 'none' }); return false }
      if (source && typeof source.prepareAssistantNavigation === 'function' && source.prepareAssistantNavigation() !== true) return false

      for (const [property, parameter] of [['patientId', 'patient_id'], ['assessmentId', 'assessment_id'], ['cycleId', 'cycle_id']]) {
        const value = this.data[property]
        if (Number.isSafeInteger(value) && value > 0) url += `&${parameter}=${value}`
      }

      this._clearGuideTimers()
      const epoch = this._navigationEpoch = (this._navigationEpoch || 0) + 1
      const current = () => this._attached !== false && this._pageVisible !== false && !this.data.paused && epoch === this._navigationEpoch
      this.setData({ navigating: true, guideBubbleVisible: false, petFeedback: '' })
      wx.navigateTo({
        url,
        success: () => {
          if (!current()) return
          this.setData({
            expanded: false
          })
        },
        fail: () => {
          if (!current()) return
          if (source && typeof source.cancelAssistantNavigation === 'function') source.cancelAssistantNavigation()
          wx.showToast({
            title: '暂时无法打开星仔助手',
            icon: 'none'
          })
        },
        complete: () => {
          if (!current()) return
          this.setData({
            navigating: false
          })
        }
      })
    }
  }
})
