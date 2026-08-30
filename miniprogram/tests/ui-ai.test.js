const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const readJson = (...parts) => JSON.parse(read(...parts))

const chatJson = readJson('pages', 'ai-chat', 'index.json')
const chatWxml = read('pages', 'ai-chat', 'index.wxml')
const chatWxss = read('pages', 'ai-chat', 'index.wxss')

assert.equal(chatJson.usingComponents['ui-icon'], '/components/ui-icon/index', 'AI 对话页必须注册 ui-icon')
assert.match(chatWxml, /class="message-avatar message-avatar--assistant"[\s\S]*?<ui-icon\s+name="ai"\s+shape="orb"/)
assert.match(chatWxml, /class="message-avatar message-avatar--user"[^>]*>\s*你\s*<\/view>/)
assert.doesNotMatch(chatWxml, /\.slice\s*\(/, '头像不得在 WXML 中调用 slice')
assert.equal((chatWxml.match(/class="thinking-dot"/g) || []).length, 3, '思考状态必须恰好有三个圆点')

for (const fragment of [
  'wx:for="{{messages}}"',
  'wx:key="id"',
  'message-row--{{item.role}}',
  '{{item.content}}',
  'wx:if="{{item.degraded}}"',
  'wx:if="{{item.usedContext.length}}"',
  'bindtap="retryMessage"',
  'data-id="{{item.id}}"',
  'bindinput="handleInput"',
  'bindconfirm="handleSend"',
  'bindtap="handleSend"',
  '{{lastDisclaimer}}'
]) {
  assert.equal(chatWxml.includes(fragment), true, `AI 对话原绑定缺少：${fragment}`)
}

assert.match(chatWxss, /\.thinking-dot\s*\{[^}]*animation:\s*thinking\s+900ms/s)
assert.match(chatWxss, /@keyframes\s+thinking/)
assert.match(chatWxss, /\.message-bubble--assistant\s*\{[^}]*background:/s)
assert.match(chatWxss, /\.message-bubble--user\s*\{[^}]*#236b80[^}]*#27758a/s)
assert.match(chatWxss, /\.chat-page\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s)
assert.match(chatWxss, /\.message-list\s*\{[^}]*flex:\s*1/s)
assert.match(chatWxss, /\.chat-shell\s*\{[^}]*height:\s*100vh[^}]*overflow:\s*hidden/s)
assert.match(chatWxss, /\.message-list\s*\{[^}]*height:\s*0[^}]*min-height:\s*0/s)
assert.match(chatWxml, /aria-role="radiogroup"/)
assert.match(chatWxml, /scroll-with-animation="\{\{false\}\}"/)
assert.doesNotMatch(chatWxml, /scroll-with-animation="false"/)
assert.match(chatWxml, /aria-role="radio"[\s\S]*aria-checked=/)
assert.match(chatWxml, /class="retry-button"[^>]*aria-role="button"/)
assert.match(chatWxss, /\.retry-button\s*\{[^}]*min-height:\s*88rpx/s)
assert.match(chatWxss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
assert.doesNotMatch(chatWxss, /height:\s*620rpx/, '消息区不得使用僵硬固定高度')

const composerRule = chatWxss.match(/\.composer\s*\{([^}]*)\}/)
assert.ok(composerRule, '缺少 composer 样式')
for (const fragment of [
  'bottom: 0',
  'constant(safe-area-inset-bottom)',
  'env(safe-area-inset-bottom)'
]) {
  assert.equal(composerRule[1].includes(fragment), true, `composer 缺少 ${fragment}`)
}
const inputRule = chatWxss.match(/\.message-input\s*\{([^}]*)\}/)
const sendRule = chatWxss.match(/\.send-button\s*\{([^}]*)\}/)
assert.match(inputRule[1], /min-height:\s*(?:8[8-9]|9\d|\d{3,})rpx/)
assert.match(sendRule[1], /(?:height|min-height):\s*(?:8[8-9]|9\d|\d{3,})rpx/)

for (const forbidden of [':active', '[disabled]', 'backdrop-filter', 'display: grid']) {
  assert.equal(chatWxss.includes(forbidden), false, `AI 对话页不得使用 ${forbidden}`)
}
assert.doesNotMatch(chatWxml, /[\u{1F300}-\u{1FAFF}]/u, 'AI 对话页不得使用 emoji')

const copilotJson = readJson('components', 'ai-copilot', 'index.json')
const copilotWxml = read('components', 'ai-copilot', 'index.wxml')
const copilotWxss = read('components', 'ai-copilot', 'index.wxss')

assert.equal(copilotJson.usingComponents['ui-icon'], '/components/ui-icon/index', 'AI Copilot 必须注册 ui-icon')
assert.equal(copilotJson.styleIsolation, 'isolated', 'AI Copilot 必须显式隔离样式')
assert.match(copilotWxml, /class="ai-copilot__trigger"[^>]*bindtap="togglePanel"[\s\S]*?<ui-icon\s+name="ai"\s+shape="orb"/)
assert.doesNotMatch(copilotWxml, /<text>\s*AI\s*<\/text>/, '悬浮入口不得继续使用文字假图标')
assert.doesNotMatch(copilotWxml, /[\u{1F300}-\u{1FAFF}]/u, 'AI Copilot 不得使用 emoji')

const copilotRootRule = copilotWxss.match(/\.ai-copilot\s*\{([^}]*)\}/)
assert.ok(copilotRootRule, 'AI Copilot 缺少根样式')
for (const fragment of [
  'bottom: 32rpx',
  'constant(safe-area-inset-bottom)',
  'env(safe-area-inset-bottom)'
]) {
  assert.equal(copilotRootRule[1].includes(fragment), true, `AI Copilot 缺少 ${fragment}`)
}
assert.match(copilotWxss, /animation:\s*copilotPulse\s+(?:1[6-9]\d{2}|[2-9]\d{3,})ms/)
assert.match(copilotWxml, /aria-expanded="\{\{expanded\}\}"/)
assert.match(copilotWxml, /expanded \? '收起AI健康助手' : '打开AI健康助手'/)
assert.match(copilotWxss, /\.ai-copilot__panel\s*\{[^}]*max-height:\s*calc\(100vh - 240rpx\)[^}]*overflow-y:\s*auto/s)
assert.match(copilotWxss, /\.ai-copilot__close\s*\{[^}]*width:\s*88rpx[^}]*height:\s*88rpx/s)
assert.match(copilotWxss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
const pulseFrames = copilotWxss.match(/@keyframes\s+copilotPulse\s*\{([\s\S]*?)\n\}/)
assert.ok(pulseFrames, 'AI Copilot 缺少克制呼吸动画')
assert.doesNotMatch(pulseFrames[1], /filter:|background:|box-shadow:/, '呼吸动画只能改变 opacity/transform')
for (const forbidden of [':active', '[disabled]', 'backdrop-filter', 'filter:', 'display: grid']) {
  assert.equal(copilotWxss.includes(forbidden), false, `AI Copilot 不得使用 ${forbidden}`)
}

console.log('AI 对话与悬浮助手视觉契约测试全部通过')
