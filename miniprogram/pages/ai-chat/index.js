// Preserve bookmarked paths; all assistant work uses the unified durable runner.
const { registerPatientPage } = require('../../utils/patient-page')
const { normalizeInitialPrompt } = require('../../utils/ai-chat')

registerPatientPage({
  data: { statusText: '正在打开星仔助手…', failed: false },
  onLoad(options = {}) {
    const values = []
    for (const name of ['patient_id', 'assessment_id', 'cycle_id']) {
      const value = Number(options[name])
      if (Number.isSafeInteger(value) && value > 0) values.push(`${name}=${value}`)
    }
    const prompt = normalizeInitialPrompt(options.prompt) || ({
      report: '请解释我当前获准的已发布报告，并说明还缺哪些依据。',
      tracking: '请结合我当前实际记录的周期，说明下一步可以做什么。'
    })[options.scope] || ''
    if (prompt) values.push(`prompt=${encodeURIComponent(prompt)}`)
    this._target = '/pages/agent-chat/index' + (values.length ? '?' + values.join('&') : '')
    this.openAgent()
  },
  openAgent() {
    if (!this._target) return
    this.setData({ statusText: '正在打开星仔助手…', failed: false })
    wx.redirectTo({ url: this._target, fail: () => {
      this.setData({ statusText: '星仔助手尚未打开，请点击重试。', failed: true })
    } })
  }
})
