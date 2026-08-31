const assert = require('node:assert/strict')

const calls = { navigateTo: [], navigateBack: [], toasts: [], clipboard: [], writes: [] }
let storage = {}
let capturedPage

global.wx = {
  getStorageSync(key) { return storage[key] },
  setStorageSync(key, value) { calls.writes.push([key, value]) },
  navigateTo(options) { calls.navigateTo.push(options) },
  navigateBack(options) { calls.navigateBack.push(options) },
  showToast(options) { calls.toasts.push(options) },
  setClipboardData(options) {
    calls.clipboard.push(options.data)
    if (options.success) options.success()
  }
}
global.Page = (definition) => { capturedPage = definition }

require('../pages/education/index.js')
const listDefinition = capturedPage
require('../pages/education-detail/index.js')
const detailDefinition = capturedPage

function createPage(definition) {
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { this.data = { ...this.data, ...patch } }
  }
}
function reset(patientType = 'adult') {
  calls.navigateTo = []; calls.navigateBack = []; calls.toasts = []
  calls.clipboard = []; calls.writes = []
  storage = {
    access_token: 'test-token',
    current_user: {
      id: 1,
      role: 'patient',
      full_name: '科普测试患者',
      patient_profile: { patient_type: patientType }
    }
  }
}
function event(dataset) { return { currentTarget: { dataset } } }

reset()
const adultList = createPage(listDefinition)
adultList.onLoad()
assert.equal(adultList.data.patientType, 'adult')
assert.equal(adultList.data.patientName, '科普测试患者')
assert.equal(adultList.data.activeCategory, 'all')
assert.equal(adultList.data.articles.length, 4)
adultList.selectCategory(event({ category: 'assessment' }))
assert.equal(adultList.data.activeCategory, 'assessment')
assert.equal(adultList.data.articles.length, 2)
adultList.selectCategory(event({ category: 'invalid' }))
assert.equal(adultList.data.activeCategory, 'assessment')
adultList.openArticle(event({ id: 'professional-assessment' }))
adultList.openArticle(event({ id: 'family-support' }))
assert.deepEqual(calls.navigateTo, [{
  url: '/pages/education-detail/index?id=professional-assessment'
}])
adultList.goBack()
assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

reset('child')
const childList = createPage(listDefinition)
childList.onLoad()
assert.equal(childList.data.articles.length, 5)
childList.selectCategory(event({ category: 'support' }))
assert.equal(childList.data.articles.length, 2)
assert.equal(childList.data.articles.some((item) => item.id === 'family-support'), true)

reset()
const detail = createPage(detailDefinition)
detail.onLoad({ id: 'understand-adhd' })
assert.equal(detail.data.validArticle, true)
assert.equal(detail.data.article.id, 'understand-adhd')
assert.equal(detail.data.article.sections.length >= 2, true)
detail.copySource(event({ index: 0 }))
assert.match(calls.clipboard[0], /^https:\/\/(www\.)?(cdc\.gov|nimh\.nih\.gov)/)
assert.equal(calls.toasts.at(-1).title, '官方链接已复制')
detail.copySource(event({ index: 99 }))
detail.copySource(event({ index: '0' }))
assert.equal(calls.clipboard.length, 1)
detail.goBack()
assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

reset()
const invalidDetail = createPage(detailDefinition)
invalidDetail.onLoad({ id: 'family-support' })
assert.equal(invalidDetail.data.validArticle, false)
assert.equal(calls.toasts.at(-1).title, '当前账号无法查看该文章')
assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

reset('child')
const childInvalid = createPage(detailDefinition)
childInvalid.onLoad({ id: 'adult-organization' })
assert.equal(childInvalid.data.validArticle, false)
assert.deepEqual(calls.writes, [])

console.log('科普列表与详情控制逻辑测试全部通过')
