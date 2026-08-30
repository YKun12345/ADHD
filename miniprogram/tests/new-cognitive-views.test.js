const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pages = [
  ['simple-reaction', '简单反应时', 'handleTargetTap'],
  ['trail', '连线测试', 'handleNodeTap'],
  ['flanker', 'Flanker', 'handleAnswer'],
  ['nback', '2-back', 'handleAnswer'],
  ['digit-span', '数字广度', 'handleDigitTap']
]

for (const [pageName, title, handler] of pages) {
  const directory = path.resolve(__dirname, `../pages/${pageName}`)
  const wxml = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8')
  const json = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'))
  assert.match(wxml, new RegExp(title, 'i'))
  assert.match(wxml, new RegExp(`bindtap="${handler}"`))
  assert.match(wxml, /测试结果|结果摘要/)
  assert.match(wxml, /不替代专业医生诊断/)
  assert.match(wxml, /ui-nav/)
  assert.match(wxss, /safe-area-inset-bottom/)
  assert.equal(json.usingComponents['ui-nav'], '/components/ui-nav/index')
}

console.log('五个新增认知页面视图测试全部通过')
