const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8')
const readJson = (...segments) => JSON.parse(read(...segments))

const app = readJson('app.json')

assert.equal(
  app.window.navigationStyle,
  'custom',
  '全局必须使用统一的自定义导航'
)

const businessPages = [
  'home',
  'privacy-settings',
  'server-settings',
  'scale',
  'cognitive-center',
  'cognitive',
  'stroop',
  'tracking',
  'tracking-trend',
  'report',
  'ai-chat',
  'care-pathway',
  'education',
  'education-detail'
]

const legacyNavigationClasses = [
  'center-nav',
  'cognitive-nav',
  'stroop-nav',
  'tracking-nav',
  'trend-nav',
  'report-nav',
  'chat-nav',
  'pathway-nav',
  'education-nav',
  'article-nav'
]

for (const page of businessPages) {
  const json = readJson('pages', page, 'index.json')
  const wxml = read('pages', page, 'index.wxml')
  const wxss = read('pages', page, 'index.wxss')
  const componentCount = (wxml.match(/<ui-nav\b/g) || []).length

  assert.equal(
    json.usingComponents && json.usingComponents['ui-nav'],
    '/components/ui-nav/index',
    `${page} 必须注册 ui-nav`
  )
  assert.equal(componentCount, 1, `${page} 必须且只能渲染一个 ui-nav`)
  assert.equal(wxss.includes('min-height: 100vh'), false, `${page} 接入文档流导航后不得继续强制 100vh`)

  for (const className of legacyNavigationClasses) {
    assert.equal(
      new RegExp(`class=["'][^"']*\\b${className}\\b`).test(wxml),
      false,
      `${page} 仍保留旧导航容器 ${className}`
    )
  }
}

const login = readJson('pages', 'login', 'index.json')
const register = readJson('pages', 'register', 'index.json')
assert.equal(login.navigationStyle, 'custom', '登录页必须使用沉浸式自定义导航')
assert.equal(register.navigationStyle, 'custom', '注册页必须使用沉浸式自定义导航')
assert.equal(register.usingComponents['ui-nav'], '/components/ui-nav/index', '注册页必须注册 ui-nav')

const component = path.join(root, 'components', 'ui-nav')
const componentJs = fs.readFileSync(path.join(component, 'index.js'), 'utf8')
const componentJson = JSON.parse(fs.readFileSync(path.join(component, 'index.json'), 'utf8'))
const componentWxml = fs.readFileSync(path.join(component, 'index.wxml'), 'utf8')
const componentWxss = fs.readFileSync(path.join(component, 'index.wxss'), 'utf8')
const uncommentedWxss = componentWxss.replace(/\/\*[\s\S]*?\*\//g, '')

assert.equal(componentJson.component, true, 'ui-nav 必须声明为组件')
assert.equal(componentJson.styleIsolation, 'isolated', 'ui-nav 必须隔离组件样式')
assert.equal(
  componentJson.usingComponents && componentJson.usingComponents['ui-icon'],
  '/components/ui-icon/index',
  'ui-nav 必须使用统一图标组件'
)

for (const [name, type] of [
  ['title', 'String'],
  ['showBack', 'Boolean'],
  ['rightText', 'String'],
  ['fallbackUrl', 'String']
]) {
  assert.match(
    componentJs,
    new RegExp(`${name}:\\s*\\{[^}]*type:\\s*${type}`),
    `ui-nav ${name} 属性类型必须是 ${type}`
  )
}
assert.match(
  componentJs,
  /fallbackUrl:\s*\{[^}]*value:\s*['"]\/pages\/home\/index['"]/,
  'ui-nav 默认兜底地址必须是患者首页'
)

assert.match(componentJs, /getWindowInfo\s*\(/, '状态栏高度应优先使用 getWindowInfo')
assert.match(componentJs, /getSystemInfoSync\s*\(/, '状态栏高度必须兼容旧版 API')
assert.match(componentJs, /getMenuButtonBoundingClientRect\s*\(/, '导航必须读取微信胶囊位置')
assert.match(componentJs, /handleBack\s*\(/, 'ui-nav 缺少返回处理')
assert.match(componentJs, /wx\.navigateBack\s*\(\s*\{\s*delta:\s*1/, '返回动作必须后退一层')
assert.match(componentJs, /triggerEvent\s*\(\s*['"]righttap['"]/, '右侧动作必须向外触发 righttap')

assert.ok(componentWxml.includes('padding-top: {{statusBarHeight}}px'), '根节点必须适配状态栏')
assert.ok(componentWxml.includes('padding-right: {{rightSafeWidth}}px'), '导航操作必须避让右上角胶囊')
assert.ok(componentWxml.includes('height: {{barHeight}}px'), '导航栏高度必须随胶囊位置校准')
assert.ok(componentWxml.includes('hover-class='), '导航交互必须有按压反馈')
assert.ok(componentWxml.includes('aria-role="button"'), '返回控件必须声明按钮语义')
assert.ok(componentWxml.includes('aria-label='), '返回控件必须提供无障碍标签')
assert.ok(componentWxml.includes('name="back"'), '返回控件必须使用 ui-icon')
assert.ok(componentWxml.includes('decorative="{{true}}"'), '返回图标应为装饰语义')

assert.match(
  uncommentedWxss,
  /:host\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/,
  'ui-nav 组件宿主必须稳定吸顶'
)
assert.match(uncommentedWxss, /z-index:\s*\d+/, 'ui-nav 需要稳定的层级')
assert.match(uncommentedWxss, /height:\s*88rpx/, '内容导航栏高度必须是 88rpx')
assert.match(uncommentedWxss, /color:\s*#173f50/i, '导航标题必须使用深蓝绿')
assert.match(uncommentedWxss, /border-bottom:/, '导航底部必须有精细分隔线')
assert.match(
  uncommentedWxss,
  /\.ui-nav__title\s*\{[^}]*position:\s*absolute[^}]*left:\s*50%[^}]*translateX\(-50%\)[^}]*pointer-events:\s*none/,
  '导航标题必须脱离两侧操作区并保持屏幕几何居中'
)
assert.equal(uncommentedWxss.includes(':active'), false, 'ui-nav 不得使用 :active')
assert.equal(uncommentedWxss.includes('[disabled]'), false, 'ui-nav 不得使用属性选择器')
assert.equal(uncommentedWxss.includes('backdrop-filter'), false, 'ui-nav 不得使用高风险滤镜')
assert.equal(uncommentedWxss.includes('display: grid'), false, '导航布局应避免依赖旧内核 Grid')

function loadComponent(wxMock, getCurrentPagesMock) {
  let config
  const context = {
    Component(value) { config = value },
    wx: wxMock
  }
  if (getCurrentPagesMock) context.getCurrentPages = getCurrentPagesMock
  vm.runInNewContext(componentJs, context)
  return config
}

const modernComponent = loadComponent({
  getWindowInfo() {
    return { statusBarHeight: 20, windowWidth: 375 }
  },
  getMenuButtonBoundingClientRect() {
    return { top: 24, left: 278, width: 87, height: 32 }
  }
})
const modernContext = {
  setData(value) { this.data = value }
}
modernComponent.lifetimes.attached.call(modernContext)
assert.equal(modernContext.data.statusBarHeight, 20)
assert.equal(modernContext.data.barHeight, 44)
assert.equal(modernContext.data.rightSafeWidth, 105)

const legacyComponent = loadComponent({
  getWindowInfo() { throw new Error('unsupported') },
  getSystemInfoSync() { return { statusBarHeight: 24, windowWidth: 360 } }
})
const legacyContext = {
  setData(value) { this.data = value }
}
legacyComponent.lifetimes.attached.call(legacyContext)
assert.equal(legacyContext.data.statusBarHeight, 24)
assert.equal(legacyContext.data.barHeight, 44)
assert.equal(legacyContext.data.rightSafeWidth, 12)

const eventCalls = []
const hiddenBackCalls = []
const behaviorComponent = loadComponent({
  navigateBack(options) { hiddenBackCalls.push(options) }
}, () => [{}, {}])
behaviorComponent.methods.handleBack.call({ properties: { showBack: false, fallbackUrl: '/pages/home/index' } })
assert.equal(hiddenBackCalls.length, 0, 'showBack=false 时不得触发返回')

const backCalls = []
const stackedComponent = loadComponent({
  navigateBack(options) { backCalls.push(options) }
}, () => [{}, {}])
stackedComponent.methods.handleBack.call({ properties: { showBack: true, fallbackUrl: '/pages/home/index' } })
assert.equal(backCalls.length, 1, '页面栈有上一页时必须 navigateBack')
assert.equal(backCalls[0].delta, 1, '返回动作必须后退一层')

const rootRelaunchCalls = []
const rootComponent = loadComponent({
  reLaunch(options) { rootRelaunchCalls.push(options) }
}, () => [{}])
rootComponent.methods.handleBack.call({ properties: { showBack: true, fallbackUrl: '/pages/login/index' } })
assert.equal(rootRelaunchCalls[0].url, '/pages/login/index', '根页面栈必须跳转到 fallbackUrl')

const failedBackRelaunchCalls = []
const failedBackComponent = loadComponent({
  navigateBack(options) { options.fail() },
  reLaunch(options) { failedBackRelaunchCalls.push(options) }
}, () => [{}, {}])
failedBackComponent.methods.handleBack.call({ properties: { showBack: true, fallbackUrl: '/pages/home/index' } })
assert.equal(failedBackRelaunchCalls[0].url, '/pages/home/index', 'navigateBack 失败必须安全回退')

const redirectCalls = []
const failedRelaunchComponent = loadComponent({
  reLaunch(options) { options.fail() },
  redirectTo(options) { redirectCalls.push(options) }
}, () => [{}])
failedRelaunchComponent.methods.handleBack.call({ properties: { showBack: true, fallbackUrl: '/pages/login/index' } })
assert.equal(redirectCalls[0].url, '/pages/login/index', 'reLaunch 失败必须回退 redirectTo')

behaviorComponent.methods.handleRightTap.call({
  properties: { rightText: '' },
  triggerEvent(name) { eventCalls.push(name) }
})
behaviorComponent.methods.handleRightTap.call({
  properties: { rightText: '清空' },
  triggerEvent(name) { eventCalls.push(name) }
})
assert.deepEqual(eventCalls, ['righttap'], '右侧动作必须且只能触发一次 righttap')

const homeWxml = read('pages', 'home', 'index.wxml')
assert.match(homeWxml, /<ui-nav\s+title="ADHD智慧辅助"\s+showBack="\{\{false\}\}"\s*\/>/)

const registerWxml = read('pages', 'register', 'index.wxml')
assert.match(registerWxml, /^<ui-nav title="患者注册" fallbackUrl="\/pages\/login\/index" \/>/)

const aiChatWxml = read('pages', 'ai-chat', 'index.wxml')
assert.match(
  aiChatWxml,
  /<ui-nav\s+title="AI 健康助手"\s+rightText="清空"\s+bind:righttap="clearConversation"\s*\/>/,
  'AI 助手必须保留清空能力'
)

console.log('统一导航契约测试全部通过')
