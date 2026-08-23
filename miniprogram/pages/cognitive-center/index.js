const { registerPatientPage } = require('../../utils/patient-page')
const {
  LATEST_RESULTS_KEY,
  buildCognitiveSummary
} = require('../../utils/cognitive-results')

const initialSummary = buildCognitiveSummary({})

registerPatientPage({
  data: {
    patientName: '患者',
    ...initialSummary
  },

  onLoad() {
    const user = wx.getStorageSync('current_user') || {}
    this.setData({
      patientName: user.full_name || '患者'
    })
  },

  onShow() {
    this.setData({
      ...buildCognitiveSummary(
        wx.getStorageSync(LATEST_RESULTS_KEY)
      )
    })
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
