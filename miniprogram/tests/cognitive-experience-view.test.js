const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

const themes = [
  ['cognitive', 'theme-lagoon'],
  ['simple-reaction', 'theme-sunrise'],
  ['stroop', 'theme-spectrum'],
  ['trail', 'theme-lavender'],
  ['flanker', 'theme-forest'],
  ['nback', 'theme-cosmos'],
  ['digit-span', 'theme-amber']
]

for (const [page, theme] of themes) {
  const wxml = read('pages', page, 'index.wxml')
  const wxss = read('pages', page, 'index.wxss')
  assert.match(wxml, new RegExp(`class="[^"]*${theme}`), `${page} 缺少主题类 ${theme}`)
  assert.match(wxss, new RegExp(`\\.${theme}`), `${page} 缺少主题样式 ${theme}`)
}

for (const page of ['cognitive', 'stroop', 'flanker', 'nback']) {
  assert.match(
    read('pages', page, 'index.wxml'),
    /精简移动筛查版/,
    `${page} 缺少精简协议说明`
  )
}

const commonWxss = read('pages', 'cognitive-task.wxss')
const commonButtonRule = commonWxss.match(/\.primary-button,\.secondary-button\s*\{([^}]*)\}/)
assert.ok(commonButtonRule, '缺少通用认知按钮规则')
for (const property of ['display: flex', 'align-items: center', 'justify-content: center', 'box-sizing: border-box']) {
  assert.equal(commonButtonRule[1].includes(property), true, `通用认知按钮缺少 ${property}`)
}

for (const page of ['flanker', 'nback']) {
  const wxss = read('pages', page, 'index.wxss')
  const answerRule = wxss.match(/\.answer-row button\s*\{([^}]*)\}/)
  assert.ok(answerRule)
  assert.match(answerRule[1], /display:\s*flex/)
  assert.match(answerRule[1], /align-items:\s*center/)
  assert.match(answerRule[1], /justify-content:\s*center/)
}

const digitWxss = read('pages', 'digit-span', 'index.wxss')
for (const selector of ['.digit-keypad button', '.keypad-actions button']) {
  const escaped = selector.replace('.', '\\.').replace(' ', '\\s+')
  const rule = digitWxss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  assert.ok(rule, `数字广度缺少 ${selector}`)
  assert.match(rule[1], /display:\s*flex/)
  assert.match(rule[1], /align-items:\s*center/)
  assert.match(rule[1], /justify-content:\s*center/)
}

console.log('认知任务主题、协议提示与按钮居中测试全部通过')
