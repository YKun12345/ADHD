const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const app = JSON.parse(read('app.json'))
const routedRoutes = collectRoutes(app)
const appWxss = read('app.wxss')
const expectedRoutes = [
  'pages/login/index',
  'pages/server-settings/index',
  'pages/home/index',
  'pages/privacy-settings/index',
  'pages/register/index',
  'pages/scale/index',
  'pages/cognitive-center/index',
  'pages/cognitive/index',
  'pages/simple-reaction/index',
  'pages/stroop/index',
  'pages/trail/index',
  'pages/flanker/index',
  'pages/nback/index',
  'pages/digit-span/index',
  'pages/tracking/index',
  'pages/tracking-trend/index',
  'pages/report/index',
  'pages/ai-chat/index',
  'pages/care-pathway/index',
  'pages/education/index',
  'pages/education-detail/index'
]
const expectedComponents = ['ai-copilot', 'ui-icon', 'ui-nav']

assert.deepEqual(
  collectRoutes({
    pages: ['pages/login/index'],
    subPackages: [{ root: 'feature', pages: ['alpha/index', 'shared/index'] }],
    subpackages: [{ root: 'feature/', pages: ['/shared/index', 'beta/index'] }]
  }),
  ['feature/alpha/index', 'feature/beta/index', 'feature/shared/index', 'pages/login/index'],
  '路由收集必须合并两种分包字段、规范化路径并去重'
)
assert.throws(
  () => assertExactRoutes(collectRoutes({
    pages: expectedRoutes,
    subPackages: [{ root: 'feature', pages: ['extra/index'] }]
  })),
  /路由集合/,
  '新增分包页面不得被忽略'
)
assert.doesNotThrow(() => assertExactComponents(expectedComponents))
assert.throws(() => assertExactComponents([...expectedComponents, 'future-widget']), /组件集合/)
assert.throws(() => assertExactComponents(expectedComponents.slice(1)), /组件集合/)

const forbiddenCss = /:active|\[disabled\]|backdrop-filter|(?:^|[;{\s])filter\s*:|display\s*:\s*grid|620rpx|330px/i
const legacyLowContrast = /#(?:8aa0a8|718096|8795a3|9aa8b5|72878f|667d86|6d838c|64748b|8aa5ad)\b/i
const forbiddenTextGlyph = /[✓✔‹›•!]/u
const forbiddenCssContentGlyph = /content\s*:\s*(['"])[^'"]*[✓✔‹›•!]\1/iu
const reducedMotionMedia = /@media\s*\(prefers-reduced-motion:\s*reduce\)/
const viewportHeightAllowList = new Set(['login', 'register', 'ai-chat', 'cognitive', 'stroop'])

function stripWxmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '')
}

function normalizeRoute(rootPath = '', pagePath = '') {
  const rootPart = String(rootPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const pagePart = String(pagePath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return [rootPart, pagePart].filter(Boolean).join('/')
}

function collectRoutes(config = {}) {
  const routes = (Array.isArray(config.pages) ? config.pages : [])
    .map((page) => normalizeRoute('', page))
  for (const field of ['subPackages', 'subpackages']) {
    const packages = Array.isArray(config[field]) ? config[field] : []
    for (const subpackage of packages) {
      for (const page of Array.isArray(subpackage.pages) ? subpackage.pages : []) {
        routes.push(normalizeRoute(subpackage.root, page))
      }
    }
  }
  return [...new Set(routes.filter(Boolean))].sort()
}

function discoverComponents(componentsRoot) {
  return fs.readdirSync(componentsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => (
      fs.existsSync(path.join(componentsRoot, name, 'index.wxml')) &&
      fs.existsSync(path.join(componentsRoot, name, 'index.wxss'))
    ))
    .sort()
}

function stripWxssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function getStaticText(wxml) {
  return [...wxml.matchAll(/>([^<]+)</g)]
    .map((match) => match[1].replace(/\{\{[\s\S]*?\}\}/g, ''))
    .join(' ')
}

function auditArtifact({ label, wxml = '', wxss = '' }) {
  const cleanWxml = stripWxmlComments(wxml)
  const cleanWxss = stripWxssComments(wxss)
  const staticText = getStaticText(cleanWxml)

  assert.doesNotMatch(cleanWxml, /\p{Extended_Pictographic}/u, `${label} 不得使用 emoji 或 pictograph 假图标`)
  assert.doesNotMatch(staticText, forbiddenTextGlyph, `${label} 不得用文字字形冒充图标`)
  assert.doesNotMatch(cleanWxss, forbiddenCssContentGlyph, `${label} 不得在 CSS content 中使用文字 glyph`)
  assert.doesNotMatch(cleanWxss, forbiddenCss, `${label} 含高风险或僵硬视觉规则`)
  assert.doesNotMatch(cleanWxss, legacyLowContrast, `${label} 含历史低对比色`)
  for (const match of cleanWxss.matchAll(/font-size\s*:\s*(\d+)rpx/g)) {
    assert.equal(Number(match[1]) >= 21, true, `${label} 含小于21rpx的显式文字`)
  }
  if (/\b(?:animation|transition)\s*:/.test(cleanWxss)) {
    assert.match(cleanWxss, reducedMotionMedia, `${label} 动效必须支持减少动态效果`)
  }
}

function assertExactRoutes(actualRoutes) {
  assert.deepEqual([...actualRoutes].sort(), [...expectedRoutes].sort(), 'app.pages 路由集合必须完整且无额外项')
}

function assertExactComponents(actualComponents) {
  assert.deepEqual([...actualComponents].sort(), [...expectedComponents].sort(), '组件集合必须完整且无额外项')
}

assert.doesNotThrow(() => auditArtifact({
  label: '注释反例',
  wxml: '<!-- <view>!</view> -->',
  wxss: '/* .old { color: #718096; font-size: 20rpx; filter: blur(2rpx); transition: all 1s; } */'
}))
assert.throws(() => auditArtifact({ label: '文字假图标反例', wxml: '<view>状态 • 待完成</view>', wxss: '' }), /文字字形/)
assert.throws(() => auditArtifact({ label: 'CSS文字图标反例', wxml: '', wxss: ".mark::after { content: '✓'; }" }), /CSS content/)
assert.throws(() => auditArtifact({ label: '组件低对比反例', wxml: '', wxss: '.copy { color: #718096; }' }), /低对比/)
assert.throws(() => auditArtifact({ label: '组件小字号反例', wxml: '', wxss: '.copy { font-size: 20rpx; }' }), /小于21rpx/)
assert.throws(() => auditArtifact({ label: '真实动效反例', wxml: '', wxss: '.copy { transition: opacity 1s; }' }), /减少动态效果/)
assert.doesNotThrow(() => assertExactRoutes(expectedRoutes))
assert.throws(() => assertExactRoutes(expectedRoutes.slice(1)), /路由集合/)

assertExactRoutes(routedRoutes)

assert.equal(app.window.navigationStyle, 'custom')
assert.equal(app.window.navigationBarTitleText, 'ADHD智慧辅助')
assert.match(appWxss, /\.ai-copilot-safe-space\.ai-copilot-safe-space\s*\{[^}]*padding-bottom\s*:\s*196rpx[^}]*constant\(safe-area-inset-bottom\)[^}]*env\(safe-area-inset-bottom\)/s)

for (const route of routedRoutes) {
  const page = route.replace(/\/index$/, '').split('/').pop()
  const config = JSON.parse(read(`${route}.json`))
  const wxml = read(`${route}.wxml`)
  const wxss = read(`${route}.wxss`)

  if (route !== 'pages/login/index') {
    assert.equal(config.usingComponents && config.usingComponents['ui-nav'], '/components/ui-nav/index', `${page} 必须注册统一导航`)
    assert.equal((wxml.match(/<ui-nav\b/g) || []).length, 1, `${page} 必须且只能渲染一个统一导航`)
  }
  auditArtifact({ label: route, wxml, wxss })
  const cleanWxml = stripWxmlComments(wxml)
  const cleanWxss = stripWxssComments(wxss)
  if (!viewportHeightAllowList.has(page)) {
    assert.doesNotMatch(cleanWxss, /(?:height|min-height)\s*:\s*100vh/, `${page} 不应锁定100vh`)
  }
  const usesGlobalSafeSpace = /ai-copilot-safe-space/.test(cleanWxml)
  const hasLocalSafeSpace = /constant\(safe-area-inset-bottom\)/.test(cleanWxss) && /env\(safe-area-inset-bottom\)/.test(cleanWxss)
  assert.equal(usesGlobalSafeSpace || hasLocalSafeSpace, true, `${page} 缺少三层底部安全区`)
  for (const icon of cleanWxml.matchAll(/<ui-icon\b[^>]*\/?\s*>/g)) {
    assert.match(icon[0], /decorative=/, `${page} 的 ui-icon 必须明确装饰语义`)
  }
}

const componentFiles = discoverComponents(path.join(root, 'components'))
assertExactComponents(componentFiles)
for (const component of componentFiles) {
  const wxml = read('components', component, 'index.wxml')
  const wxss = read('components', component, 'index.wxss')
  auditArtifact({ label: component, wxml, wxss })
}

assert.throws(
  () => assertExactRoutes(app.pages.filter((route) => route !== 'pages/report/index')),
  /路由集合/
)

const trackingWxml = read('pages', 'tracking', 'index.wxml')
assert.match(trackingWxml, /class="day-chip[^>]*aria-pressed="\{\{dayIndex === item\}\}"/s)
assert.match(trackingWxml, /class="choice-button[^>]*aria-pressed="\{\{moodTag === item\.value\}\}"/s)
assert.match(trackingWxml, /class="rating-button[^>]*aria-pressed="\{\{attentionRating === item\}\}"/s)
assert.match(trackingWxml, /class="sleep-button[^>]*aria-pressed="\{\{sleepQuality === item\.value\}\}"/s)
assert.match(trackingWxml, /class="demo-button ui-button ui-button--secondary"[^>]*hover-class="ui-button--pressed"/s)

assert.match(read('pages', 'login', 'index.wxss'), /\.login-tip\s*\{[^}]*min-height\s*:\s*88rpx/s)
assert.match(read('pages', 'login', 'index.wxss'), /\.server-entry\s*\{[^}]*min-height\s*:\s*88rpx/s)
assert.match(read('pages', 'home', 'index.wxss'), /\.privacy-settings-entry[\s\S]*\.server-settings-entry\s*\{[^}]*min-height\s*:\s*88rpx/s)
assert.match(read('pages', 'register', 'index.wxss'), /\.gender-option\s*\{[^}]*min-height\s*:\s*88rpx/s)
assert.match(read('pages', 'register', 'index.wxss'), /\.back-login\s*\{[^}]*min-height\s*:\s*88rpx/s)

const aiWxml = read('pages', 'ai-chat', 'index.wxml')
assert.match(aiWxml, /class="context-tab[^>]*hover-class="chat-control--pressed"/s)
assert.match(aiWxml, /class="retry-button"[^>]*hover-class="chat-control--pressed"/s)
assert.match(aiWxml, /class="suggestion-item"[^>]*hover-class="chat-control--pressed"/s)

for (const page of ['scale', 'cognitive', 'stroop']) {
  const wxml = read('pages', page, 'index.wxml')
  const wxss = read('pages', page, 'index.wxss')
  assert.doesNotMatch(getStaticText(stripWxmlComments(wxml)), forbiddenTextGlyph)
  assert.match(wxml, /result-icon[^>]*aria-hidden="true"/)
  assert.match(wxss, /\.result-icon::after\s*\{[^}]*border-(?:left|bottom)/s)
}
assert.match(read('pages', 'scale', 'index.wxml'), /unsupported-icon[^>]*aria-hidden="true"/)
assert.match(read('pages', 'scale', 'index.wxss'), /\.unsupported-icon::before[\s\S]*\.unsupported-icon::after/)
assert.match(read('pages', 'cognitive-center', 'index.wxml'), /class="test-arrow"\s+aria-hidden="true"><\/view>/)
assert.match(read('pages', 'cognitive-center', 'index.wxss'), /\.test-arrow\s*\{[^}]*border-top[^}]*border-right/s)
assert.match(read('pages', 'cognitive-center', 'index.wxml'), /completion-banner[\s\S]*completion-banner__mark[^>]*aria-hidden="true"[\s\S]*七项任务已完成/)
assert.match(read('pages', 'scale', 'index.wxml'), /recommendation-dot"\s+aria-hidden="true"><\/view>/)
assert.match(read('pages', 'scale', 'index.wxss'), /\.recommendation-dot\s*\{[^}]*border-radius\s*:\s*50%/s)

const serverWxml = read('pages', 'server-settings', 'index.wxml')
assert.match(serverWxml, /class="address-input ui-input"[^>]*aria-label="服务器地址"/s)

const educationWxml = read('pages', 'education', 'index.wxml')
assert.match(educationWxml, /资料尚未完善或当前分类暂无内容/)

assert.doesNotThrow(() => auditArtifact({ label: 'app.wxss', wxml: '', wxss: appWxss }))
assert.match(appWxss, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.ui-button[\s\S]*\.ui-pressable[\s\S]*\.ui-button--pressed[\s\S]*\.ui-clickable--pressed[\s\S]*transform\s*:\s*none/s)
const aiWxss = read('pages', 'ai-chat', 'index.wxss')
assert.match(aiWxss, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.send-button--pressed[\s\S]*\.chat-control--pressed[\s\S]*transform\s*:\s*none/s)
const copilotWxss = read('components', 'ai-copilot', 'index.wxss')
assert.match(copilotWxss, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.ai-copilot__control--pressed[\s\S]*\.ai-copilot__trigger--pressed[\s\S]*transform\s*:\s*none/s)

console.log('全项目视觉与无障碍最终审计契约测试全部通过')
