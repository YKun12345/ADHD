const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pages = [
  ['simple-reaction', '简单反应时', 'handleTargetTap'],
  ['trail', '连线测试', 'handleNodeTap'],
  ['flanker', '箭头抗干扰任务', 'handleAnswer'],
  ['nback', '两步位置记忆任务', 'handleAnswer'],
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

  if (pageName === 'flanker' || pageName === 'nback') {
    assert.match(wxml, /phase === 'break'/, `${pageName} 缺少分节休息阶段`)
    assert.match(wxml, /{{breakTitle}}/)
    assert.match(wxml, /{{breakMessage}}/)
    assert.match(wxml, /bindtap="continueSection"/)
    assert.match(wxss, /\.section-break-card/)
  }

  if (pageName === 'trail') {
    assert.match(wxml, /<canvas\b[^>]*canvas-id="trail-lines"/)
    assert.match(wxml, /节点位置会在每次开始时重新排列/)
    assert.match(wxss, /\.trail-lines[\s\S]*pointer-events:\s*none/)
  }
}

const digitView = fs.readFileSync(path.resolve(__dirname, '../pages/digit-span/index.wxml'), 'utf8')
assert.match(digitView, /连续两轮未答对后会提前结束该方向/)
assert.doesNotMatch(digitView, /所有预设长度都会完成/)

console.log('五个新增认知页面视图测试全部通过')
