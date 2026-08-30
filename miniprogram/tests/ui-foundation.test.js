const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const appWxssPath = path.join(__dirname, '..', 'app.wxss')
const appWxss = fs.readFileSync(appWxssPath, 'utf8')

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function parseDeclarations(body) {
  return body
    .split(';')
    .map((declaration) => {
      const separatorIndex = declaration.indexOf(':')

      if (separatorIndex === -1) return null

      return {
        property: declaration.slice(0, separatorIndex).trim(),
        value: declaration.slice(separatorIndex + 1).trim()
      }
    })
    .filter(Boolean)
}

function parseRules(css) {
  const rules = []
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g
  const uncommentedCss = stripCssComments(css)
  let match

  while ((match = rulePattern.exec(uncommentedCss)) !== null) {
    rules.push({
      selectors: match[1].split(',').map((selector) => selector.trim()),
      declarations: parseDeclarations(match[2])
    })
  }

  return rules
}

function selectorHasDeclaration(rules, selector, property, valueMatches) {
  return rules.some((rule) =>
    rule.selectors.includes(selector) &&
    rule.declarations.some((declaration) =>
      declaration.property === property && valueMatches(declaration.value)
    )
  )
}

function exactRuleHasDeclaration(rules, selector, property, valueMatches) {
  return rules.some((rule) =>
    rule.selectors.length === 1 &&
    rule.selectors[0] === selector &&
    rule.declarations.some((declaration) =>
      declaration.property === property && valueMatches(declaration.value)
    )
  )
}

function selectorHasSafeAreaPadding(rules, selector) {
  return rules.some((rule) =>
    rule.selectors.includes(selector) &&
    rule.declarations.some((declaration) =>
      (declaration.property === 'padding' ||
        declaration.property === 'padding-bottom') &&
      declaration.value.includes('env(safe-area-inset-bottom)')
    )
  )
}

function selectorHasPaddingValue(rules, selector, expectedValue) {
  return selectorHasDeclaration(
    rules,
    selector,
    'padding',
    (value) => value === expectedValue
  )
}

const parserCounterexamples = parseRules(`
  /* page { --ui-ink: #173f50; } */
  /* .ui-page { padding-bottom: env(safe-area-inset-bottom); } */
  page { --ui-ink: #173f500; }
  page, .theme { --ui-ink: #173f50; }
  .wrapper .ui-page { padding-bottom: env(safe-area-inset-bottom); }
  .ui-button.is-active, .field .ui-input { min-height: 88rpx; }
  .other { padding: env(safe-area-inset-bottom); min-height: 88rpx; }
`)

assert.equal(
  exactRuleHasDeclaration(
    parserCounterexamples,
    'page',
    '--ui-ink',
    (value) => value === '#173f50'
  ),
  false,
  '解析器不能把注释或更长的颜色值当作设计变量'
)
assert.equal(
  parserCounterexamples.some((rule) => rule.selectors.includes('.ui-page')),
  false,
  '解析器不能把后代或复合选择器当作基础选择器'
)
assert.equal(
  selectorHasDeclaration(
    parserCounterexamples,
    '.ui-input',
    'min-height',
    (value) => value === '88rpx'
  ),
  false,
  '解析器不能把无关选择器的触控高度关联到 .ui-input'
)
assert.equal(
  selectorHasSafeAreaPadding(parserCounterexamples, '.ui-page'),
  false,
  '解析器不能把注释或无关选择器的安全区关联到 .ui-page'
)

const selectorListExample = parseRules(
  '.ui-card, .glass-surface { border-width: 1rpx; }'
)
assert.equal(
  selectorListExample[0].selectors.includes('.glass-surface'),
  true,
  '解析器需要支持精确的选择器列表'
)

const appRules = parseRules(appWxss)

const requiredDesignTokens = [
  ['--ui-ink', '#173f50'],
  ['--ui-text', '#506b75'],
  ['--ui-muted', '#5d747d'],
  ['--ui-bg', '#f2f8fa'],
  ['--ui-primary', '#236b80'],
  ['--ui-highlight', '#50bee0'],
  ['--ui-cognitive', '#7367d9'],
  ['--ui-success', '#4aa997'],
  ['--ui-warning', '#e0a45b'],
  ['--ui-danger', '#e06f67']
]

for (const [token, value] of requiredDesignTokens) {
  assert.equal(
    exactRuleHasDeclaration(
      appRules,
      'page',
      token,
      (declarationValue) => declarationValue === value
    ),
    true,
    `page 规则缺少设计变量 ${token}: ${value}`
  )
}

const requiredFoundationClasses = [
  '.ui-page',
  '.ui-card',
  '.glass-surface',
  '.ui-button',
  '.ui-button--primary',
  '.ui-button--secondary',
  '.ui-button--pressed',
  '.ui-clickable--pressed',
  '.ui-button--disabled',
  '.ui-input'
]

for (const className of requiredFoundationClasses) {
  assert.equal(
    appRules.some((rule) => rule.selectors.includes(className)),
    true,
    `全局样式缺少基础类 ${className}`
  )
}

for (const selector of ['.ui-button', '.ui-input']) {
  assert.equal(
    selectorHasDeclaration(
      appRules,
      selector,
      'min-height',
      (value) => value === '88rpx'
    ),
    true,
    `${selector} 规则缺少 min-height: 88rpx`
  )
}

assert.equal(
  selectorHasSafeAreaPadding(appRules, '.ui-page'),
  true,
  '.ui-page 的 padding 规则缺少 env(safe-area-inset-bottom)'
)

for (const paddingValue of [
  '32rpx 32rpx 56rpx',
  '32rpx 32rpx calc(56rpx + constant(safe-area-inset-bottom))',
  '32rpx 32rpx calc(56rpx + env(safe-area-inset-bottom))'
]) {
  assert.equal(
    selectorHasPaddingValue(appRules, '.ui-page', paddingValue),
    true,
    `.ui-page 缺少安全区回退 padding: ${paddingValue}`
  )
}

assert.equal(appWxss.includes(':active'), false, '全局 WXSS 不得使用 :active，请使用 hover-class')
assert.equal(appWxss.includes('[disabled]'), false, '全局 WXSS 不得使用属性选择器表达禁用态')

assert.equal(
  selectorHasDeclaration(
    appRules,
    '.ui-button--primary',
    'background',
    (value) => value === 'linear-gradient(135deg, #236b80 0%, #27758a 100%)'
  ),
  true,
  '主按钮渐变必须满足文字对比度要求'
)

assert.equal(
  selectorHasDeclaration(
    appRules,
    '.ui-button--secondary',
    'color',
    (value) => value === '#236b80'
  ),
  true,
  '次按钮文字色必须满足对比度要求'
)

console.log('全局冰川玻璃视觉契约测试全部通过')
