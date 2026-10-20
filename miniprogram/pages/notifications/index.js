const { request } = require('../../utils/request')
const { hasValidAnySession } = require('../../utils/role-session')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent, reLaunchSafely } = require('../../utils/session-privacy')

const REASONS = {
  missing_app_id: '尚未配置小程序身份', missing_app_secret: '尚未配置微信服务凭据',
  missing_template_id: '尚未配置订阅模板', template_fields_not_configured: '尚未确认订阅模板字段',
  invalid_miniprogram_state: '微信版本配置待确认', delivery_disabled: '微信投递当前关闭', worker_disabled: '微信提醒尚未开通',
  wechat_not_bound: '请先绑定当前微信', notifications_paused: '提醒已暂停，可重新申请一次',
  one_time_permission_required: '需要您点击申请一次提醒', quiet_hours: '安静时段，白天再发送',
  daily_limit: '已到今日提醒上限', recipient_busy: '另有提醒正在处理',
  original_authority_unavailable: '原共享关系或资格已变化，已停止投递',
  binding_integrity_unavailable: '微信绑定无法核实，已停止这条提醒，请联系机构核对',
  wechat_permission_unavailable: '微信许可不足，请重新申请一次',
  wechat_binding_invalid: '微信绑定失效，请重新绑定', wechat_template_invalid: '微信模板待配置',
  wechat_template_banned: '微信模板当前不可用', wechat_template_fields_invalid: '微信模板字段待核对',
  wechat_concurrent_send: '微信暂时拒绝并发提醒', wechat_rejected: '微信未受理此次提醒',
  wechat_unavailable: '暂时无法连接微信服务', wechat_invalid_response: '微信返回无法核实',
  wechat_delivery_unknown: '送达结果不明，已停止自动重发', worker_interrupted: '发送中断，结果不明',
  wechat_binding_not_configured: '尚未配置微信绑定服务', wechat_login_code_invalid: '微信登录凭证已失效，请重试',
  wechat_login_code_used: '微信登录凭证已使用，请重新绑定'
}
const STATUSES = { pending: '等待核对', blocked: '暂不可投递', sending: '发送中', sent: '微信已受理',
  failed: '发送失败', unknown: '结果不明', suppressed: '已停止投递' }
const BUSINESS_PAGES = ['/pages/shared-messages/index', '/pages/care-reports/index',
  '/pages/patient-plan/index', '/pages/care-attention/index']
const NOT_OPEN = '微信提醒尚未开通，站内待办和消息照常使用。'
const CONFIG_REASONS = ['missing_app_id', 'missing_app_secret', 'missing_template_id',
  'template_fields_not_configured', 'invalid_miniprogram_state', 'delivery_disabled', 'worker_disabled', 'wechat_binding_not_configured']

Page({
  data: { loading: false, busy: false, bound: false, enabled: false, bindingRevision: null,
    availablePermissions: 0, canBind: false, canSubscribe: false, blockerText: '', errorText: '', items: [] },

  onLoad() { this._entryLease = capturePatientSessionLease() },
  onShow() {
    this._hidden = false
    if (!hasValidAnySession()) { this._clear(); reLaunchSafely('/pages/login/index', '请重新登录后管理提醒'); return }
    if (!this._entryLease) this._entryLease = capturePatientSessionLease()
    if (!this._current()) return
    return this.refresh()
  },
  onHide() { this._hidden = true; this._clear() },
  onUnload() { this._ended = true; this._clear() },
  onPatientSessionEnded() { this._ended = true; this._clear() },

  _clear() {
    this._version = (this._version || 0) + 1
    this._challenge = null
    this.setData({ loading: false, busy: false, bound: false, enabled: false, bindingRevision: null,
      availablePermissions: 0, canBind: false, canSubscribe: false, blockerText: '', errorText: '', items: [] })
  },
  _current(version) {
    const valid = !this._hidden && !this._ended && hasValidAnySession() && isPatientSessionLeaseCurrent(this._entryLease)
    if (!valid) { this._clear(); return false }
    return version === undefined || version === this._version
  },
  _error(error) {
    const message = error && error.message
    return CONFIG_REASONS.includes(message) ? NOT_OPEN : REASONS[message] || (message && !/^[a-z_]+$/.test(message) ? message : '提醒服务暂不可用，请稍后重试')
  },
  async refresh() {
    if (!this._current()) return
    const version = this._version = (this._version || 0) + 1
    this._challenge = null
    this.setData({ loading: true, canSubscribe: false, errorText: '' })
    try {
      const status = await request({ url: '/notifications' })
      if (!this._current(version)) return
      this.setData({ bound: Boolean(status.bound), enabled: Boolean(status.enabled), bindingRevision: status.binding_revision,
        canBind: status.binding_ready === true,
        availablePermissions: Number(status.available_permissions) || 0,
        blockerText: (status.blockers || []).some(reason => CONFIG_REASONS.includes(reason)) ? NOT_OPEN
          : (status.blockers || []).map(reason => REASONS[reason] || '当前不可投递').join('；'),
        items: (status.items || []).map(item => ({ ...item, statusText: STATUSES[item.status] || '待核对',
          reasonText: REASONS[item.reason] || (item.reason ? '暂不可投递，请稍后核对' : '') })) })
      // Prepare only a nonce; the subscription dialog is opened solely by a later tap.
      if (status.bound && status.template_ready && status.delivery_enabled) {
        const challenge = await request({ url: '/notifications/permission-requests', method: 'POST' })
        if (!this._current(version)) return
        this._challenge = challenge
        this.setData({ canSubscribe: Boolean(challenge.permission_id && challenge.template_id) })
      }
    } catch (error) {
      if (this._current(version)) this.setData({ errorText: this._error(error) })
    } finally {
      if (this._current(version)) this.setData({ loading: false, busy: false })
    }
  },

  bindWechat() {
    if (!this._current() || this.data.busy || this.data.loading) return
    if (!this.data.canBind) { this.setData({ errorText: NOT_OPEN }); return }
    if (typeof wx.login !== 'function') { this.setData({ errorText: '请在微信小程序内绑定' }); return }
    const version = this._version
    this.setData({ busy: true, errorText: '' })
    wx.login({
      success: async result => {
        if (!this._current(version)) return
        if (!result || !result.code) { this.setData({ busy: false, errorText: '未取得微信登录凭证，请重试' }); return }
        try {
          await request({ url: '/notifications/wechat-bind', method: 'POST', data: { code: result.code } })
          if (this._current(version)) await this.refresh()
        } catch (error) {
          if (this._current(version)) this.setData({ busy: false, errorText: this._error(error) })
        }
      },
      fail: () => { if (this._current(version)) this.setData({ busy: false, errorText: '微信登录暂未完成，请重试' }) }
    })
  },

  subscribeOnce() {
    if (!this._current() || this.data.busy || this.data.loading || !this.data.canSubscribe || !this._challenge) return
    if (typeof wx.requestSubscribeMessage !== 'function') { this.setData({ errorText: '请在支持订阅消息的微信版本中使用' }); return }
    const challenge = this._challenge
    const version = this._version
    this._challenge = null
    this.setData({ busy: true, canSubscribe: false, errorText: '' })
    const record = async result => {
      if (!this._current(version)) return
      try {
        await request({ url: `/notifications/permission-requests/${encodeURIComponent(challenge.permission_id)}/result`,
          method: 'POST', data: { result } })
        if (this._current(version)) await this.refresh()
      } catch (error) {
        if (this._current(version)) this.setData({ busy: false, errorText: this._error(error) })
      }
    }
    // Keep this call synchronous with the user tap; do not await a server request first.
    wx.requestSubscribeMessage({ tmplIds: [challenge.template_id],
      success: result => record(['accept', 'reject', 'ban', 'filter'].includes(result && result[challenge.template_id])
        ? result[challenge.template_id] : 'failed'), fail: () => record('failed') })
  },

  async revoke() {
    if (!this._current() || this.data.busy || !this.data.bindingRevision) return
    const version = this._version
    this.setData({ busy: true, errorText: '' })
    try {
      await request({ url: '/notifications/revoke', method: 'POST', data: { expected_binding_revision: this.data.bindingRevision } })
      if (this._current(version)) await this.refresh()
    } catch (error) {
      if (this._current(version)) this.setData({ busy: false, errorText: this._error(error) })
    }
  },

  async openBusiness(event) {
    if (!this._current() || this.data.busy) return
    const identifier = event && event.currentTarget && event.currentTarget.dataset.id
    if (!this.data.items.some(item => item.id === identifier)) return
    const version = this._version
    this.setData({ busy: true, errorText: '' })
    try {
      const result = await request({ url: `/notifications/${encodeURIComponent(identifier)}/resolve` })
      if (!this._current(version)) return
      const positive = value => Number.isSafeInteger(value) && value > 0
      if (!result || result.notification_id !== identifier || !BUSINESS_PAGES.includes(result.page) || !positive(result.patient_id)) {
        throw new Error('提醒的业务入口无法核实，请刷新后重试')
      }
      let url = `${result.page}?patient_id=${result.patient_id}`
      if (result.page === '/pages/shared-messages/index') {
        if (!positive(result.relationship_id)) throw new Error('原共享关系无法核实')
        url += `&relationship_id=${result.relationship_id}`
      }
      if (['/pages/care-reports/index', '/pages/patient-plan/index'].includes(result.page)) {
        if (!positive(result.assessment_id)) throw new Error('原评估无法核实')
        url += `&assessment_id=${result.assessment_id}`
      }
      wx.navigateTo({ url, fail: () => { if (this._current(version)) this.setData({ errorText: '页面未能打开，请重试' }) } })
    } catch (error) {
      if (this._current(version)) this.setData({ errorText: error.statusCode === 403 || error.statusCode === 409
        ? '当前身份或原共享授权不可用，请在账号与隐私中核对' : this._error(error) })
    } finally {
      if (this._current(version)) this.setData({ busy: false })
    }
  }
})
