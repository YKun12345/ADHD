const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function read(page, file) {
  return fs.readFileSync(path.join(__dirname, '..', 'pages', page, file), 'utf8')
}
const listWxml = read('education', 'index.wxml')
const listWxss = read('education', 'index.wxss')
const detailWxml = read('education-detail', 'index.wxml')
const detailWxss = read('education-detail', 'index.wxss')

const listFragments = [
  'ADHD科普中心', '{{patientName}}', '内容已内置，断网也可阅读',
  'wx:for="{{categories}}"',
  'category-tab--{{activeCategory === item.id ? \'active\' : \'idle\'}}',
  'bindtap="selectCategory"', 'data-category="{{item.id}}"',
  'wx:for="{{articles}}"', '{{item.title}}', '{{item.summary}}',
  '{{item.readMinutes}} 分钟', '{{item.updatedAt}}',
  'bindtap="openArticle"', 'data-id="{{item.id}}"',
  'CDC、NIMH 与 NICE', '不替代专业医生诊断'
]
for (const fragment of listFragments) assert.equal(listWxml.includes(fragment), true, `列表 WXML 缺少：${fragment}`)

const detailFragments = [
  'wx:if="{{validArticle}}"', '{{article.title}}', '{{article.summary}}',
  '{{article.readMinutes}} 分钟', '{{article.updatedAt}}',
  'wx:for="{{article.sections}}"', '{{item.heading}}',
  'wx:for="{{item.paragraphs}}"', 'wx:for="{{item.points}}"',
  '权威来源', 'wx:for="{{article.sources}}"',
  '{{item.organization}}', '{{item.title}}',
  'bindtap="copySource"', 'data-index="{{index}}"',
  '复制官方链接', '{{article.disclaimer}}'
]
for (const fragment of detailFragments) assert.equal(detailWxml.includes(fragment), true, `详情 WXML 缺少：${fragment}`)

for (const markup of [listWxml, detailWxml]) {
  assert.equal(markup.includes('<image'), false, '科普页面不得依赖远程图片')
  assert.equal(markup.includes('<web-view'), false, '科普页面不得依赖未配置业务域名')
  assert.equal(markup.includes('<rich-text'), false, '科普正文只允许纯文本')
}

for (const selector of ['.education-page', '.offline-badge', '.category-tabs', '.category-tab--active', '.article-list', '.article-card', '.source-note', '.medical-tip']) {
  assert.equal(listWxss.includes(selector), true, `列表 WXSS 缺少：${selector}`)
}
for (const selector of ['.article-page', '.article-header', '.article-section', '.article-point', '.source-list', '.source-card', '.source-button', '.article-disclaimer']) {
  assert.equal(detailWxss.includes(selector), true, `详情 WXSS 缺少：${selector}`)
}
const sourceButtonRule = detailWxss.match(/\.source-button\s*\{([^}]*)\}/)
assert.ok(sourceButtonRule)
assert.match(sourceButtonRule[1], /display:\s*flex/)
assert.match(sourceButtonRule[1], /align-items:\s*center/)
assert.match(sourceButtonRule[1], /justify-content:\s*center/)

console.log('科普列表与详情视图结构测试全部通过')
