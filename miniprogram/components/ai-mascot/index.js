const REACTIONS = ['blink', 'tilt', 'wave']
const REACTION_DURATION = { blink: 900, tilt: 1500, wave: 1800 }
function spriteFrame(state, reaction) {
  if (state === 'idle') return reaction === 'blink' ? 1 : reaction === 'wave' ? 2 : 0
  if (state === 'sleep' || state === 'happy') return 1
  return ['wave', 'guide', 'success'].includes(state) ? 2 : 0
}

Component({
  properties: {
    state: {
      type: String,
      value: 'idle'
    },
    label: {
      type: String,
      value: '星仔 · AI健康小助手'
    },
    decorative: {
      type: Boolean,
      value: false
    },
    active: {
      type: Boolean,
      value: true
    },
    reducedMotion: {
      type: Boolean,
      value: false
    },
    touchManaged: {
      type: Boolean,
      value: false
    }
  },
  data: {
    reaction: '',
    motionActive: false,
    spriteSource: '/assets/product/xingzai-sprite.png',
    spriteFrame: 0,
    spriteReady: false,
    spriteFailed: false
  },
  observers: {
    'state, active, reducedMotion, decorative': function () {
      this._syncMotion()
    }
  },
  lifetimes: {
    attached() {
      this._attached = true
      this._pageVisible = true
      this._reactionIndex = 0
      this._reactionGeneration = 0
      this._syncMotion()
    },
    detached() {
      this._attached = false
      this._pageVisible = false
      this._clearReactionTimer()
    }
  },
  pageLifetimes: {
    show() {
      this._pageVisible = true
      this._syncMotion()
    },
    hide() {
      this._pageVisible = false
      this._syncMotion()
    }
  },
  methods: {
    onSpriteLoad(event) {
      if (!this._attached) return
      const detail = event && event.detail || {}
      if (!(detail.height > 0 && detail.width === detail.height * 3)) {
        this.onSpriteError()
        return
      }
      this.setData({ spriteReady: true, spriteFailed: false })
    },
    onSpriteError() {
      if (!this._attached) return
      this._clearReactionTimer()
      this.setData({ spriteReady: false, spriteFailed: true, reaction: '', spriteFrame: spriteFrame(this.data.state, '') })
      this.triggerEvent('rendererror', { source: this.data.spriteSource })
    },
    _clearReactionTimer() {
      if (this._reactionTimer !== undefined && this._reactionTimer !== null) {
        clearTimeout(this._reactionTimer)
      }
      this._reactionTimer = null
      // A callback already queued before clearTimeout must not erase a newer state.
      this._reactionGeneration = (this._reactionGeneration || 0) + 1
    },
    _syncMotion() {
      if (!this._attached) return
      this._clearReactionTimer()
      this.setData({
        reaction: '',
        spriteFrame: spriteFrame(this.data.state, ''),
        motionActive: Boolean(this._pageVisible && this.data.active && !this.data.reducedMotion)
      })
    },
    onInteract(event) {
      if (!this._attached || !this._pageVisible || !this.data.active || this.data.decorative) return
      // A draggable parent confirms the gesture before calling this method directly.
      if (this.data.touchManaged && event) return
      const state = this.data.state
      // Parent-controlled business states always take priority over playful reactions.
      if (state !== 'idle') {
        this.triggerEvent('interact', { state, reaction: '', accepted: false, animated: false })
        return
      }
      this._clearReactionTimer()
      const reaction = REACTIONS[this._reactionIndex % REACTIONS.length]
      this._reactionIndex += 1
      const animated = !this.data.reducedMotion
      this.setData({ reaction, spriteFrame: spriteFrame(state, reaction) })
      if (animated) {
        const generation = this._reactionGeneration
        this._reactionTimer = setTimeout(() => {
          if (!this._attached || generation !== this._reactionGeneration) return
          this._reactionTimer = null
          this.setData({ reaction: '', spriteFrame: spriteFrame(this.data.state, '') })
        }, REACTION_DURATION[reaction])
      }
      this.triggerEvent('interact', { state, reaction, accepted: true, animated })
    }
  }
})
