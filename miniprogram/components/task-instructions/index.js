Component({
  properties: { visible: Boolean, content: Object, remaining: Number, ready: Boolean },
  methods: {
    stopPropagation() {},
    start() {
      if (this.data.visible && this.data.ready && this.data.remaining === 0) this.triggerEvent('start')
    }
  }
})
