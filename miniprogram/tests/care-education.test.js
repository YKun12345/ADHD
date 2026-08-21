const assert = require('node:assert/strict')

const {
  PATHWAY_STEP_IDS,
  EDUCATION_CATEGORIES,
  EDUCATION_ARTICLES,
  buildCarePathway,
  listEducationArticles,
  getEducationArticle
} = require('../utils/care-education')

assert.deepEqual(PATHWAY_STEP_IDS, [
  'account',
  'scale',
  'cognitive',
  'tracking',
  'report'
])
assert.deepEqual(
  EDUCATION_CATEGORIES.map((item) => item.id),
  ['all', 'basics', 'assessment', 'support']
)
assert.equal(EDUCATION_ARTICLES.length, 6)

const emptyPathway = buildCarePathway(null, false)
assert.equal(emptyPathway.completedCount, 0)
assert.equal(emptyPathway.totalCount, 5)
assert.equal(emptyPathway.percent, 0)
assert.equal(emptyPathway.complete, false)
assert.equal(emptyPathway.currentStep.id, 'account')
assert.deepEqual(
  emptyPathway.steps.map((item) => item.status),
  ['pending', 'pending', 'pending', 'pending', 'pending']
)

const partialReport = {
  scale: { hasData: true, scaleTypeLabel: 'ASRS 成人自评量表' },
  cognitive: { hasData: true, completedCount: 1, totalCount: 2 },
  tracking: { hasData: true, completedCount: 3, totalDays: 14 },
  coverage: { completedCount: 3, totalCount: 3, percent: 100 },
  sourceLabel: '本地结果'
}
const partialPathway = buildCarePathway(partialReport, true)
assert.equal(partialPathway.completedCount, 2)
assert.equal(partialPathway.percent, 40)
assert.equal(partialPathway.complete, false)
assert.equal(partialPathway.currentStep.id, 'cognitive')
assert.equal(partialPathway.currentStep.actionUrl, '/pages/cognitive-center/index')
assert.deepEqual(
  partialPathway.steps.map((item) => item.status),
  ['done', 'done', 'partial', 'partial', 'partial']
)
assert.equal(partialPathway.steps[1].detail, 'ASRS 成人自评量表已完成')
assert.equal(partialPathway.steps[2].detail, '已完成 1 / 2 项')
assert.equal(partialPathway.steps[3].detail, '已记录 3 / 14 天')
assert.match(partialPathway.steps[4].detail, /阶段性报告/)
assert.equal(partialPathway.sourceLabel, '本地结果')

const completePathway = buildCarePathway({
  scale: { hasData: true, scaleTypeLabel: 'SNAP-IV 儿童量表' },
  cognitive: { hasData: true, completedCount: 99, totalCount: 2 },
  tracking: { hasData: true, completedCount: 99, totalDays: 14 },
  coverage: { completedCount: 3 },
  sourceLabel: '已同步'
}, true)
assert.equal(completePathway.completedCount, 5)
assert.equal(completePathway.percent, 100)
assert.equal(completePathway.complete, true)
assert.equal(completePathway.currentStep, null)
assert.equal(completePathway.sourceLabel, '已同步')
assert.equal(completePathway.steps[2].detail, '已完成 2 / 2 项')
assert.equal(completePathway.steps[3].detail, '已记录 14 / 14 天')
assert.deepEqual(
  completePathway.steps.map((item) => item.actionUrl),
  [
    '',
    '/pages/scale/index',
    '/pages/cognitive-center/index',
    '/pages/tracking/index',
    '/pages/report/index'
  ]
)

const malformedPathway = buildCarePathway({
  scale: { hasData: 'yes' },
  cognitive: { completedCount: -3 },
  tracking: { completedCount: Infinity },
  coverage: { completedCount: 9 },
  sourceLabel: ''
}, true)
assert.deepEqual(
  malformedPathway.steps.map((item) => item.status),
  ['done', 'pending', 'pending', 'pending', 'pending']
)
assert.equal(malformedPathway.sourceLabel, '本地结果')

const adultArticles = listEducationArticles('adult')
const childArticles = listEducationArticles('child')
assert.equal(adultArticles.length, 4)
assert.equal(childArticles.length, 5)
assert.equal(adultArticles.some((item) => item.id === 'family-support'), false)
assert.equal(adultArticles.some((item) => item.id === 'school-support'), false)
assert.equal(adultArticles.some((item) => item.id === 'adult-organization'), true)
assert.equal(childArticles.some((item) => item.id === 'adult-organization'), false)
assert.equal(childArticles.some((item) => item.id === 'family-support'), true)
assert.equal(childArticles.some((item) => item.id === 'school-support'), true)

assert.equal(listEducationArticles('adult', 'assessment').length, 2)
assert.equal(listEducationArticles('child', 'support').length, 2)
assert.deepEqual(listEducationArticles('adult', 'unknown'), [])
assert.deepEqual(listEducationArticles('unknown'), [])

const basicsArticle = getEducationArticle('understand-adhd', 'adult')
assert.equal(basicsArticle.categoryId, 'basics')
assert.equal(basicsArticle.sections.length >= 2, true)
assert.equal(basicsArticle.sources.length >= 2, true)
assert.match(basicsArticle.disclaimer, /不替代专业医生诊断/)
assert.equal(getEducationArticle('family-support', 'adult'), null)
assert.equal(getEducationArticle('adult-organization', 'child'), null)
assert.equal(getEducationArticle('missing', 'adult'), null)
assert.equal(getEducationArticle('', 'adult'), null)

for (const article of EDUCATION_ARTICLES) {
  assert.equal(Boolean(
    article.id &&
    article.categoryId &&
    article.title &&
    article.summary &&
    article.readMinutes > 0 &&
    article.updatedAt &&
    article.sections.length &&
    article.sources.length &&
    article.disclaimer
  ), true)
  for (const source of article.sources) {
    assert.equal(/^https:\/\/(www\.)?(cdc\.gov|nimh\.nih\.gov|nice\.org\.uk)\//.test(source.url), true)
    assert.equal(Boolean(source.title && source.organization), true)
  }
}

console.log('临床路径与科普数据测试全部通过')
