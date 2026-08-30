const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const pages = [
  'care-pathway',
  'education',
  'education-detail',
  'privacy-settings',
  'server-settings'
]

for (const page of pages) {
  const config = JSON.parse(read('pages', page, 'index.json'))
  const wxml = read('pages', page, 'index.wxml')
  const wxss = read('pages', page, 'index.wxss')
  assert.equal(config.usingComponents['ui-nav'], '/components/ui-nav/index')
  assert.equal(config.usingComponents['ui-icon'], '/components/ui-icon/index')
  assert.equal((wxml.match(/<ui-nav\b/g) || []).length, 1)
  assert.match(wxml, /<ui-icon\b/)
  assert.doesNotMatch(wxml, /[\u{1F300}-\u{1FAFF}]/u)
  assert.doesNotMatch(wxss, /:active|\[disabled\]|backdrop-filter|\bfilter\s*:|display\s*:\s*grid/i)
  assert.match(wxss, /padding-bottom\s*:\s*[^;]+;/)
  assert.match(wxss, /constant\(safe-area-inset-bottom\)/)
  assert.match(wxss, /env\(safe-area-inset-bottom\)/)
  for (const match of wxss.matchAll(/font-size\s*:\s*(\d+)rpx/g)) {
    assert.equal(Number(match[1]) >= 21, true, `${page} contains text smaller than 21rpx`)
  }
}

const careWxml = read('pages', 'care-pathway', 'index.wxml')
const careWxss = read('pages', 'care-pathway', 'index.wxss')
assert.match(careWxml, /name="pathway"[\s\S]*shape="orbit"/)
assert.match(careWxml, /pathway-step__state-mark/)
assert.match(careWxml, /name="ai"[\s\S]*shape="orb"/)
assert.match(careWxml, /name="education"[\s\S]*shape="book"/)
assert.match(careWxss, /\.pathway-step__line/)
assert.match(careWxss, /\.pathway-step--done[\s\S]*\.pathway-step__state-mark/)
assert.match(careWxss, /\.pathway-step--partial[\s\S]*animation\s*:\s*pathwayPulse/)
assert.match(careWxss, /\.pathway-step--pending[\s\S]*border/)
assert.match(careWxss, /\.step-action\s*\{[^}]*min-height\s*:\s*88rpx/s)

const educationWxml = read('pages', 'education', 'index.wxml')
const educationWxss = read('pages', 'education', 'index.wxss')
assert.match(educationWxml, /name="education"[\s\S]*shape="book"/)
assert.match(educationWxml, /class="category-tabs"[^>]*aria-role="radiogroup"/)
assert.match(educationWxml, /aria-role="radio"[\s\S]*aria-checked="\{\{activeCategory === item\.id\}\}"/)
assert.match(educationWxml, /article-card__chevron/)
assert.doesNotMatch(educationWxml, /article-card__arrow/)
assert.match(educationWxml, /hover-class="education-control--pressed"/)
assert.match(educationWxml, /wx:if="\{\{!articles\.length\}\}"[\s\S]*article-empty/)
assert.match(educationWxml, /暂无内容/)
assert.match(educationWxss, /\.education-header[\s\S]*#fff[0-9a-f]{3}/i)
assert.match(educationWxss, /\.article-list[\s\S]*border/i)

const detailWxml = read('pages', 'education-detail', 'index.wxml')
const detailWxss = read('pages', 'education-detail', 'index.wxss')
assert.match(detailWxml, /name="education"[\s\S]*shape="book"/)
assert.match(detailWxml, /article-point__mark/)
assert.doesNotMatch(detailWxml, /article-point__dot/)
assert.match(detailWxss, /\.article-paragraph\s*\{[^}]*font-size\s*:\s*27rpx[^}]*line-height\s*:\s*1\.85/s)
assert.match(detailWxss, /\.article-section__heading/)
assert.match(detailWxss, /\.article-disclaimer[\s\S]*border-left/)
assert.match(detailWxss, /\.source-button\s*\{[^}]*min-height\s*:\s*88rpx/s)

const privacyWxml = read('pages', 'privacy-settings', 'index.wxml')
const privacyWxss = read('pages', 'privacy-settings', 'index.wxss')
assert.match(privacyWxml, /setting-sheet/)
assert.match(privacyWxml, /name="report"[\s\S]*shape="sheet"/)
assert.match(privacyWxml, /clear-button ui-button[\s\S]*ui-button--disabled/)
assert.match(privacyWxml, /logout-button ui-button[\s\S]*ui-button--disabled/)
assert.match(privacyWxss, /\.clear-button[\s\S]*border\s*:[^;]*#b54747/i)
assert.doesNotMatch(privacyWxss, /\.clear-button[^}]*background\s*:\s*#b54747/i)
assert.match(privacyWxss, /\.back-link\s*\{[^}]*min-height\s*:\s*88rpx/s)

const serverWxml = read('pages', 'server-settings', 'index.wxml')
const serverWxss = read('pages', 'server-settings', 'index.wxss')
assert.match(serverWxml, /settings-card glass-surface/)
assert.match(serverWxml, /address-input ui-input/)
assert.match(serverWxml, /test-button ui-button ui-button--primary/)
assert.match(serverWxml, /reset-button ui-button ui-button--secondary/)
assert.match(serverWxml, /status-mark status-mark--\{\{statusType\}\}/)
assert.match(serverWxml, /confirm-type="done"/)
assert.match(serverWxml, /bindconfirm="testAndSave"/)
assert.match(serverWxss, /\.status-mark--success/)
assert.match(serverWxss, /\.status-mark--error/)
assert.match(serverWxss, /\.address-input\s*\{[^}]*min-height\s*:\s*88rpx/s)
assert.match(serverWxss, /\.environment-card\s*>\s*view\s*\{[^}]*min-width\s*:\s*0/s)
assert.match(serverWxss, /\.environment-address\s*\{[^}]*word-break\s*:\s*break-all/s)
assert.match(serverWxss, /\.environment-badge\s*\{[^}]*flex-shrink\s*:\s*0/s)

console.log('support page visual contracts passed')
