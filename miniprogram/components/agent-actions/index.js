const { request } = require('../../utils/request')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const { targetUrl } = require('../../utils/agent-actions')
const { orderedActions } = require('../../utils/xingzai-actions')
const positive = value => Number.isInteger(value) && value > 0
const canonical = value => JSON.stringify(value)
Component({
  properties: { tone:{type:String,value:'focus'}, patientId: { type: Number, value: 0, observer() {
    if (!this._active) return
      this._epoch = (this._epoch || 0) + 1; this.setData({ items: [], profiles: [], selectedPatientId: 0, loading: false, busy: false, actionIndex: 0 })
    return this.reload()
  } } },
  data: { items: [], profiles: [], profileIndex: 0, selectedPatientId: 0, loading: false, busy: false, errorText: '', modeText: '', actionIndex: 0 },
  lifetimes: {
    attached() { this._active = true; this._lease = capturePatientSessionLease(); const actor = wx.getStorageSync('current_user') || {}
      this._actor = actor.id; this._role = actor.role; return this.reload() },
    detached() { this._ended = true; this.stop() }
  },
  pageLifetimes: { show() { if (!this._ended) { this._active = true; return this.reload() } }, hide() { this.stop() } },
  methods: {
    stop() { this._active = false; this._epoch = (this._epoch || 0) + 1; this.setData({ items: [], profiles: [], loading: false, busy: false, errorText: '', modeText: '', actionIndex: 0 }) },
    usable() { const actor = wx.getStorageSync('current_user') || {}; const ok = !this._ended && this._active && actor.id === this._actor &&
      actor.role === this._role && ['patient', 'researcher'].includes(actor.role) && isPatientSessionLeaseCurrent(this._lease)
      if (!ok && this._active) { this._ended = true; this.stop() } return ok },
    current(epoch) { return this.usable() && this._epoch === epoch },
    async reload() {
      if (!this.usable() || this.data.loading || this.data.busy) return false
      const epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ loading: true, items: [], errorText: '' })
      try {
        let pid = this.data.patientId
        if (!positive(pid)) {
          const result = await request({ url: this._role === 'researcher' ? '/doctor/my_patients' : '/identity/context' }); if (!this.current(epoch)) return false
          const profiles = this._role === 'researcher' ? result.items : result.accessible_patients
          if (!Array.isArray(profiles)) throw new Error('档案列表不完整。')
          const choices = profiles.filter(row => positive(row.patient_id)).map(row => ({ patient_id: row.patient_id,
            label: row.display_name || row.patient_name || `获准档案 ${row.patient_id}` }))
          if (!choices.length) { this.setData({ loading: false, profiles: [], modeText: '请先确认本人、监护或医患共享关系。' }); return true }
          const index = Math.max(0, choices.findIndex(row => row.patient_id === this.data.selectedPatientId))
          pid = choices[index].patient_id; this.setData({ profiles: choices, profileIndex: index })
        }
        const response = await request({ url: `/agent/actions?patient_id=${pid}` }); if (!this.current(epoch)) return false
        if (response.patient_id !== pid || response.actor_user_id !== this._actor || !Array.isArray(response.items)) throw new Error('助手动作归属不一致。')
        response.items.forEach(row => { if (!positive(row.id) || row.patient_id !== pid || row.actor_user_id !== this._actor || row.status !== 'available') throw new Error('助手动作状态不完整。')
          targetUrl(row.target, { role: this._role, patientId: pid }) })
        const resumeId = response.companion?.protocol === 'Xingzai-flow-1' && positive(response.companion.resume_action_id) ? response.companion.resume_action_id : null
        this.setData({ loading: false, selectedPatientId: pid, items: orderedActions(response.items, resumeId), actionIndex: 0,
          modeText: response.mode === 'history_only' ? '当前可查看历史；新增处理授权不可用。' : resumeId && response.items.some(row => row.id === resumeId) ? '接着上次这一步继续；打开时重新核对当前状态。' : '根据实际已保存业务给出下一步，点击后重新核对。' }); return true
      } catch (failure) { if (this.current(epoch)) this.setData({ loading: false, items: [], errorText: failure.message || '助手暂时未读取到下一步，可继续使用原业务页面。' }); return false }
    },
    async selectProfile(event) {
      if (!this.usable() || this.data.busy) return false
      const index = Number(event.detail.value), row = this.data.profiles[index]; if (!row) return false
      this._epoch = (this._epoch || 0) + 1; this.setData({ items: [], profileIndex: index, selectedPatientId: row.patient_id, loading: false, actionIndex: 0 }); return this.reload()
    },
    slideAction(event) { const index = Number(event.detail.current); if (this.usable() && Number.isInteger(index) && index >= 0 && index < this.data.items.length) this.setData({ actionIndex: index }) },
    openChat() { if (this.usable() && this.data.selectedPatientId) wx.navigateTo({ url: `/pages/agent-chat/index?patient_id=${this.data.selectedPatientId}` }) },
    async openAction(event) {
      if (!this.usable() || this.data.busy || this.data.loading) return false
      const id = Number(event.currentTarget.dataset.id), row = this.data.items.find(value => value.id === id)
      if (!row) return false
      const pid = this.data.selectedPatientId, epoch = this._epoch = (this._epoch || 0) + 1; this.setData({ busy: true, errorText: '' })
      try {
        const result = await request({ url: `/agent/actions/${id}/resolve`, method: 'POST', data: { patient_id: pid, expected_action_digest: row.action_digest } })
        if (!this.current(epoch)) return false
        if (result.action_id !== id || result.patient_id !== pid || result.action_digest !== row.action_digest || result.revalidated !== true || canonical(result.target) !== canonical(row.target)) throw new Error('动作或来源已变化，请刷新下一步。')
        const url = targetUrl(result.target, { role: this._role, patientId: pid }); this.setData({ busy: false }); wx.navigateTo({ url }); return true
      } catch (failure) { if (this.current(epoch)) this.setData({ busy: false, items: [], errorText: failure.message || '动作已变化，请刷新。' }); return false }
    }
  }
})
