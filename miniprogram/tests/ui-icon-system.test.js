const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const componentDir = path.join(__dirname, '..', 'components', 'ui-icon')
const js = fs.readFileSync(path.join(componentDir, 'index.js'), 'utf8')
const json = JSON.parse(fs.readFileSync(path.join(componentDir, 'index.json'), 'utf8'))
const wxml = fs.readFileSync(path.join(componentDir, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(componentDir, 'index.wxss'), 'utf8')
const uncommentedWxss = wxss.replace(/\/\*[\s\S]*?\*\//g, '')

assert.equal(json.component, true, 'ui-icon 必须声明为组件')
assert.equal(json.styleIsolation, 'isolated', 'ui-icon 必须隔离组件样式')

for (const property of ['name', 'shape', 'label']) {
  assert.match(js, new RegExp(`${property}:\\s*\\{[^}]*type:\\s*String`), `${property} 必须是 String 属性`)
}
assert.match(js, /decorative:\s*\{[^}]*type:\s*Boolean[^}]*value:\s*true/, '图标必须默认采用装饰语义')
assert.match(js, /name:\s*\{[^}]*value:\s*'plan'/, 'name 默认值必须是 plan')
assert.match(js, /shape:\s*\{[^}]*value:\s*'orbit'/, 'shape 默认值必须是 orbit')

assert.ok(wxml.includes('ui-icon ui-icon--{{name}} ui-icon--shape-{{shape}}'), '根节点缺少动态名称或形状类')
assert.ok(wxml.includes('aria-label="{{label}}"'), '图标缺少无障碍标签')
assert.ok(wxml.includes("decorative ? 'none' : 'img'"), '图标没有区分装饰与信息语义')
assert.ok(wxml.includes('aria-hidden="{{decorative}}"'), '装饰图标必须对读屏隐藏')
for (const layer of ['a', 'b', 'c', 'd']) {
  assert.ok(wxml.includes(`ui-icon__${layer}`), `图标缺少几何层 ${layer}`)
}

for (const name of [
  'plan', 'scale', 'cognitive', 'gonogo', 'stroop',
  'speed', 'trail', 'flanker', 'nback', 'digit',
  'report', 'tracking', 'pathway', 'education', 'ai', 'back'
]) {
  assert.match(uncommentedWxss, new RegExp(`\\.ui-icon--${name}(?=[\\s,{])`), `缺少精确图标样式 ${name}`)
}

for (const shape of ['orbit', 'sheet', 'lens', 'pill', 'book', 'orb', 'target', 'path', 'arrows', 'grid', 'digits']) {
  assert.match(uncommentedWxss, new RegExp(`\\.ui-icon--shape-${shape}(?=[\\s,{])`), `缺少精确容器形状 ${shape}`)
}

assert.match(uncommentedWxss, /:host\s*\{[^}]*display:\s*inline-flex/, '组件宿主必须明确参与行内 Flex 布局')
assert.match(uncommentedWxss, /:host\s*\{[^}]*pointer-events:\s*none/, '非交互图标不得拦截父级触控')
assert.match(
  uncommentedWxss,
  /\.ui-icon__a,[\s\S]*\.ui-icon__d\s*\{[^}]*top:\s*50%[^}]*left:\s*50%[^}]*translate\(-50%,\s*-50%\)/,
  '几何层必须显式定义中心基准，不能依赖 flex 静态位置'
)

const openingBraces = (uncommentedWxss.match(/\{/g) || []).length
const closingBraces = (uncommentedWxss.match(/\}/g) || []).length
assert.equal(openingBraces, closingBraces, 'WXSS 大括号不平衡')
assert.equal(/(?:bind|catch)tap=/.test(wxml), false, '图标组件不应自行绑定触控事件')

assert.equal(/[\p{Extended_Pictographic}]/u.test(wxml + wxss), false, '图标组件不得使用 emoji')
assert.equal(wxss.includes('[disabled]'), false, '图标组件不得使用属性选择器')
assert.equal(wxss.includes(':active'), false, '图标组件不得依赖 :active')
assert.equal(wxss.includes('backdrop-filter'), false, '图标组件不得使用高风险滤镜')

console.log('模块图形系统测试全部通过')
