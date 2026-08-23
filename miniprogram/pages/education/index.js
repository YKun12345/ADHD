const { registerPatientPage } = require('../../utils/patient-page')
const {
  EDUCATION_CATEGORIES,
  listEducationArticles,
  getEducationArticle
} = require('../../utils/care-education')

function userProfile() {
  const user = wx.getStorageSync('current_user') || {}
  const profile = user.patient_profile || {}
  const rawType = String(profile.patient_type || '').toLowerCase()
  return {
    patientName: typeof user.full_name === 'string' && user.full_name.trim()
      ? user.full_name.trim()
      : '患者',
    patientType: rawType === 'adult' || rawType === 'child' ? rawType : ''
  }
}

registerPatientPage({
  data: {
    patientName: '患者',
    patientType: '',
    categories: EDUCATION_CATEGORIES,
    activeCategory: 'all',
    articles: []
  },

  onLoad() {
    const profile = userProfile()
    this.setData({
      ...profile,
      activeCategory: 'all',
      articles: listEducationArticles(profile.patientType)
    })
  },

  selectCategory(event) {
    const categoryId = event && event.currentTarget
      ? event.currentTarget.dataset.category
      : ''
    if (!EDUCATION_CATEGORIES.some((item) => item.id === categoryId)) return
    this.setData({
      activeCategory: categoryId,
      articles: listEducationArticles(this.data.patientType, categoryId)
    })
  },

  openArticle(event) {
    const articleId = event && event.currentTarget
      ? event.currentTarget.dataset.id
      : ''
    if (!getEducationArticle(articleId, this.data.patientType)) return
    wx.navigateTo({
      url: `/pages/education-detail/index?id=${encodeURIComponent(articleId)}`
    })
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})
