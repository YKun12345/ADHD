const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const readJson = (...parts) => JSON.parse(read(...parts))
const pages = ['scale', 'cognitive-center', 'cognitive', 'stroop']

for (const page of pages) {
  const json = readJson('pages', page, 'index.json')
  const wxml = read('pages', page, 'index.wxml')
  const wxss = read('pages', page, 'index.wxss')

  assert.equal(
    json.usingComponents && json.usingComponents['ui-icon'],
    '/components/ui-icon/index',
    `${page} 必须注册 ui-icon`
  )
  assert.match(wxml, /ai-copilot-safe-space/, `${page} 必须为悬浮助手预留安全空间`)
  assert.doesNotMatch(wxml, /[\u{1F300}-\u{1FAFF}]/u, `${page} 不得使用 emoji`)
  for (const forbidden of [':active', '[disabled]', 'backdrop-filter', 'display: grid']) {
    assert.equal(wxss.includes(forbidden), false, `${page} 不得使用 ${forbidden}`)
  }
  for (const lowContrast of ['#718096', '#8795a3', '#9aa8b5']) {
    assert.equal(wxss.toLowerCase().includes(lowContrast), false, `${page} 不得使用低对比色 ${lowContrast}`)
  }
  assert.equal(/font-size:\s*(?:[01]?\d|20)rpx/.test(wxss), false, `${page} 状态和结果文字不得小于21rpx`)
}

const scaleWxml = read('pages', 'scale', 'index.wxml')
const scaleWxss = read('pages', 'scale', 'index.wxss')
assert.match(scaleWxml, /class="scale-card glass-surface"/)
assert.match(scaleWxml, /class="option-button ui-button/)
assert.match(scaleWxml, /class="navigation-button[^"}]*ui-button/)
assert.match(scaleWxml, /class="option-check"/)
assert.match(scaleWxml, /selectedValue === item\.value \? 'option-button--selected' : ''/)
assert.match(scaleWxml, /data-value="\{\{item\.value\}\}"/)
assert.match(scaleWxml, /bindtap="selectOption"/)
assert.match(scaleWxml, /aria-pressed="\{\{selectedValue === item\.value\}\}"/)
assert.match(scaleWxml, /disabled="\{\{submitting\}\}"/)
assert.match(scaleWxml, /submitting \? 'ui-button--disabled' : ''/)
assert.match(scaleWxml, /hover-class="\{\{submitting \? 'none' : 'ui-clickable--pressed'\}\}"/)
assert.match(scaleWxss, /\.option-check\s*\{[^}]*border:/s)
assert.match(scaleWxss, /\.option-button--selected\s+\.option-check\s*\{[^}]*opacity:\s*1/s)
assert.match(scaleWxss, /\.option-button\s*\{[^}]*(?:height|min-height):\s*(?:8[8-9]|9\d|\d{3,})rpx/s)

const centerWxml = read('pages', 'cognitive-center', 'index.wxml')
assert.match(centerWxml, /<ui-icon\s+name="\{\{item\.iconName\}\}"/)
assert.match(centerWxml, /shape="\{\{item\.iconShape\}\}"/)
assert.doesNotMatch(centerWxml, /\{\{item\.icon\}\}/, '认知中心不得继续渲染文字假图标')
assert.equal(read('pages', 'cognitive-center', 'index.wxss').includes('.center-nav'), false, '认知中心必须删除旧导航死样式')

const cognitiveWxml = read('pages', 'cognitive', 'index.wxml')
const cognitiveWxss = read('pages', 'cognitive', 'index.wxss')
assert.match(cognitiveWxml, /<ai-copilot\s+wx:if="\{\{phase === 'intro' \|\| phase === 'result'\}\}"\s+page-key="cognitive"\s*\/>/)
assert.match(cognitiveWxml, /class="cognitive-page [^"]*\{\{[^}]*cognitive-page--testing/)
assert.match(cognitiveWxml, /<ui-icon\s+name="gonogo"\s+shape="pill"/)
assert.match(cognitiveWxml, /<ui-icon\s+name="gonogo"\s+shape="pill"[^>]*decorative="\{\{true\}\}"/)
assert.match(cognitiveWxml, /GO · 需要反应/)
assert.match(cognitiveWxml, /NO-GO · 保持抑制/)
assert.match(cognitiveWxss, /\.cognitive-page--testing\s*\{[^}]*background:\s*#f5f8f9/s)
assert.match(cognitiveWxss, /\.cognitive-page--testing\s+\.test-stage\s*\{[^}]*background:\s*#fff(?:fff)?/s)
assert.match(cognitiveWxml, /class="test-stage"[^>]*aria-role="button"[^>]*aria-label="\{\{phase === 'waiting'/)
assert.match(cognitiveWxml, /<view class="cognitive-shell \{\{[^}]*cognitive-shell--testing/)
assert.match(cognitiveWxss, /\.cognitive-shell--testing\s*\{[^}]*height:\s*100vh[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*overflow:\s*hidden/s)
assert.match(cognitiveWxss, /\.cognitive-shell--testing\s+\.cognitive-page\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s)
assert.equal(cognitiveWxss.includes('.cognitive-nav'), false, 'Go/No-Go 必须删除旧导航死样式')

const stroopWxml = read('pages', 'stroop', 'index.wxml')
const stroopWxss = read('pages', 'stroop', 'index.wxss')
assert.match(stroopWxml, /<ai-copilot\s+wx:if="\{\{phase === 'intro' \|\| phase === 'result'\}\}"\s+page-key="stroop"\s*\/>/)
assert.match(stroopWxml, /class="stroop-page [^"]*\{\{[^}]*stroop-page--testing/)
assert.match(stroopWxml, /<ui-icon\s+name="stroop"\s+shape="lens"/)
assert.match(stroopWxml, /<ui-icon\s+name="stroop"\s+shape="lens"[^>]*decorative="\{\{true\}\}"/)
assert.match(stroopWxml, /文字是“红”，实际颜色是蓝，应选择“蓝”/)
assert.match(stroopWxss, /\.stroop-page--testing\s*\{[^}]*background:\s*#f5f8f9/s)
assert.match(stroopWxml, /<view class="stroop-shell \{\{[^}]*stroop-shell--testing/)
assert.match(stroopWxss, /\.stroop-shell--testing\s*\{[^}]*height:\s*100vh[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*overflow:\s*hidden/s)
assert.match(stroopWxss, /\.stroop-shell--testing\s+\.stroop-page\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s)
assert.equal(stroopWxss.includes('.stroop-nav'), false, 'Stroop 必须删除旧导航死样式')
const colorButtonRule = stroopWxss.match(/\.color-button\s*\{([^}]*)\}/)
assert.ok(colorButtonRule, 'Stroop 缺少颜色按钮样式')
assert.match(colorButtonRule[1], /background:\s*(?:#fff(?:fff)?|rgba\(255,\s*255,\s*255)/)
assert.doesNotMatch(colorButtonRule[1], /color-button--|item\.hex/)
assert.match(stroopWxml, /class="color-swatch"\s+style="\{\{'background: ' \+ item\.hex/)

console.log('量表与认知测试冰川玻璃视觉契约测试全部通过')
