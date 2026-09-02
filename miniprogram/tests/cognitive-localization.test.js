const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { TEST_DEFINITIONS } = require('../utils/cognitive-results')
const { getCopilotConfig } = require('../utils/ai-copilot')
const { getPageGuide } = require('../utils/page-guide-content')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const visibleText = (wxml) => [
  ...(wxml.matchAll(/>([^<>]+)</g)),
  ...(wxml.matchAll(/<ui-nav\b[^>]*\btitle="([^"]+)"/g))
].map((match) => match[1]).join(' ')

const expectedTitles = {
  reaction: '反应抑制任务',
  stroop: '颜色干扰任务',
  flanker: '箭头抗干扰任务',
  nback: '两步位置记忆任务'
}

for (const [id, title] of Object.entries(expectedTitles)) {
  assert.equal(TEST_DEFINITIONS.find((item) => item.id === id).title, title)
}

assert.equal(getCopilotConfig('cognitive').title, '反应抑制任务')
assert.equal(getCopilotConfig('stroop').title, '颜色干扰任务')
assert.doesNotMatch(getPageGuide('cognitive').helpPrompt, /Go\/No-Go/)
assert.doesNotMatch(getPageGuide('stroop').helpPrompt, /Stroop/)
assert.doesNotMatch(getPageGuide('flanker').helpPrompt, /Flanker/)
assert.doesNotMatch(getPageGuide('nback').helpPrompt, /2-back/i)

for (const page of ['stroop', 'flanker', 'nback']) {
  assert.doesNotMatch(
    visibleText(read('pages', page, 'index.wxml')),
    /Stroop|Flanker|2-back/i,
    `${page} 页面仍包含患者不易理解的英文任务名`
  )
}

assert.doesNotMatch(visibleText(read('pages', 'report', 'index.wxml')), /Go\/No-Go|Stroop|Flanker|2-back/i)

const loginWxml = read('pages', 'login', 'index.wxml')
const homeWxml = read('pages', 'home', 'index.wxml')
assert.doesNotMatch(loginWxml, /brand-icon-shell|name="plan"\s+shape="orbit"/)
assert.doesNotMatch(homeWxml, /welcome-mark|name="plan"\s+shape="orbit"/)

console.log('认知任务中文化与入口圆环移除测试全部通过')
