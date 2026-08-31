const { registerPatientPage } = require('../../utils/patient-page')
const {
  LATEST_RESULTS_KEY,
  buildCognitiveSummary
} = require('../../utils/cognitive-results')
const { resolveAgeGroup } = require('../../utils/cognitive-config')
const {
  BATTERY_STATE_KEY,
  createBatteryState,
  normalizeBatteryState,
  nextBatteryTask
} = require('../../utils/cognitive-battery')

const initialSummary = buildCognitiveSummary({})

registerPatientPage({
  data: {
    patientName: '患者',
    patientKey: '',
    ageGroup: 'child',
    batteryActionText: '开始完整评估',
    remainingMinutes: 44,
    ...initialSummary
  },

  onLoad() {
    const user = wx.getStorageSync('current_user') || {}
    this.setData({
      patientName: user.full_name || '患者',
      patientKey: String(user.id || user.email || 'patient'),
      ageGroup: resolveAgeGroup(user)
    })
  },

  onShow() {
    const summary = buildCognitiveSummary(wx.getStorageSync(LATEST_RESULTS_KEY))
    const battery = normalizeBatteryState(
      wx.getStorageSync(BATTERY_STATE_KEY),
      this.data.patientKey
    )
    const completedIds = battery ? battery.completedTaskIds : []
    const remainingMinutes = summary.cards
      .filter((card) => !completedIds.includes(card.id))
      .reduce((sum, card) => sum + (card.estimatedMinutes || 0), 0)
    this.setData({
      ...summary,
      batteryActionText: battery && completedIds.length
        ? (battery.completed ? '重新开始完整评估' : '继续完整评估')
        : '开始完整评估',
      remainingMinutes
    })
  },

  startOrResumeBattery() {
    const stored = normalizeBatteryState(
      wx.getStorageSync(BATTERY_STATE_KEY),
      this.data.patientKey
    )
    const state = stored && !stored.completed
      ? stored
      : createBatteryState(this.data.patientKey, this.data.ageGroup)
    wx.setStorageSync(BATTERY_STATE_KEY, state)
    const taskId = nextBatteryTask(state)
    const card = this.data.cards.find((item) => item.id === taskId)
    if (!card) return
    wx.navigateTo({ url: `${card.url}?mode=battery` })
  },

  handleTestTap(event) {
    const id = event.currentTarget.dataset.id
    const card = this.data.cards.find((item) => item.id === id)

    if (!card || !card.url) {
      return
    }

    wx.navigateTo({
      url: card.url
    })
  },

  goBack() {
    wx.navigateBack({
      delta: 1
    })
  }
})
