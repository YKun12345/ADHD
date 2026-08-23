const { registerPatientPage } = require('../../utils/patient-page')
const { getEducationArticle } = require('../../utils/care-education')

function currentPatientType() {
  const user = wx.getStorageSync('current_user') || {}
  const profile = user.patient_profile || {}
  const patientType = String(profile.patient_type || '').toLowerCase()
  return patientType === 'adult' || patientType === 'child'
    ? patientType
    : ''
}

registerPatientPage({
  data: {
    validArticle: false,
    article: null
  },

  onLoad(options = {}) {
    const articleId = typeof options.id === 'string'
      ? decodeURIComponent(options.id)
      : ''
    const article = getEducationArticle(articleId, currentPatientType())
    if (!article) {
      wx.showToast({
        title: '当前账号无法查看该文章',
        icon: 'none'
      })
      wx.navigateBack({ delta: 1 })
      return
    }
    this.setData({
      validArticle: true,
      article
    })
  },

  copySource(event) {
    const index = event && event.currentTarget
      ? event.currentTarget.dataset.index
      : null
    if (!Number.isInteger(index) || !this.data.validArticle) return
    const source = this.data.article.sources[index]
    if (!source) return

    wx.setClipboardData({
      data: source.url,
      success() {
        wx.showToast({
          title: '官方链接已复制',
          icon: 'success'
        })
      }
    })
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})
