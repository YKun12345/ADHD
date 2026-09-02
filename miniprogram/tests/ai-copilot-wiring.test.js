const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pageKeys = [
  'home',
  'scale',
  'cognitive-center',
  'cognitive',
  'simple-reaction',
  'stroop',
  'trail',
  'flanker',
  'nback',
  'digit-span',
  'tracking',
  'tracking-trend',
  'report',
  'care-pathway',
  'education',
  'education-detail',
  'patient-tasks',
  'patient-messages',
  'privacy-settings',
  'doctor-home',
  'doctor-patient',
  'doctor-guide-settings',
  'ai-chat'
]

const excludedPages = [
  'login',
  'register',
  'server-settings'
]

const pagesRoot = path.join(__dirname, '..', 'pages')

for (const pageKey of pageKeys) {
  const directory = path.join(pagesRoot, pageKey)
  const config = JSON.parse(
    fs.readFileSync(path.join(directory, 'index.json'), 'utf8')
  )
  const wxml = fs.readFileSync(
    path.join(directory, 'index.wxml'),
    'utf8'
  )

  assert.equal(
    config.usingComponents && config.usingComponents['ai-copilot'],
    '/components/ai-copilot/index',
    `${pageKey} 未声明 ai-copilot`
  )
  if (pageKey === 'cognitive' || pageKey === 'stroop' || pageKey === 'flanker' || pageKey === 'nback') {
    assert.match(
      wxml,
      new RegExp(`<ai-copilot\\s+wx:if="\\{\\{!submitting && \\(phase === 'intro' \\|\\| phase === 'break' \\|\\| phase === 'result'\\)\\}\\}"\\s+page-key="${pageKey}"\\s*/>`),
      `${pageKey} 必须仅在介绍、休息和结果阶段渲染 ai-copilot`
    )
  } else if (['simple-reaction', 'digit-span'].includes(pageKey)) {
    assert.match(wxml, new RegExp(`<ai-copilot\\s+wx:if="\\{\\{!submitting && \\(phase === 'intro' \\|\\| phase === 'result'\\)\\}\\}"\\s+page-key="${pageKey}"\\s*/>`))
  } else if (pageKey === 'trail') {
    assert.match(wxml, /<ai-copilot\s+wx:if="\{\{!submitting && \(phase === 'intro' \|\| phase === 'rest' \|\| phase === 'result'\)\}\}"\s+page-key="trail"\s*\/>/)
  } else if (pageKey === 'ai-chat') {
    assert.match(wxml, /<ai-copilot\s+wx:if="\{\{!inputFocused && !sending\}\}"\s+page-key="ai-chat"\s*\/>/)
  } else if (pageKey === 'tracking') {
    assert.match(wxml, /<ai-copilot\s+wx:if="\{\{!noteFocused && !submitting\}\}"\s+page-key="tracking"\s*\/>/)
  } else if (pageKey === 'home' || pageKey === 'doctor-home' || pageKey === 'doctor-guide-settings' || pageKey === 'privacy-settings') {
    assert.match(wxml, new RegExp(`<ai-copilot\\s+wx:if="\\{\\{!onboardingVisible\\}\\}"\\s+page-key="${pageKey}"\\s*/>`))
  } else if (pageKey === 'patient-messages') {
    assert.match(wxml, /<ai-copilot\s+wx:if="\{\{!inputFocused && !sending\}\}"\s+page-key="patient-messages"\s*\/>/)
  } else if (pageKey === 'doctor-patient') {
    assert.match(wxml, /<ai-copilot\s+wx:if="\{\{!inputFocused && !sending && !creatingTask\}\}"\s+page-key="doctor-patient"\s*\/>/)
  } else {
    assert.equal(
      wxml.includes(`<ai-copilot page-key="${pageKey}" />`),
      true,
      `${pageKey} 未渲染 ai-copilot`
    )
  }
}

for (const pageKey of excludedPages) {
  const directory = path.join(pagesRoot, pageKey)
  const config = JSON.parse(
    fs.readFileSync(path.join(directory, 'index.json'), 'utf8')
  )
  const wxml = fs.readFileSync(
    path.join(directory, 'index.wxml'),
    'utf8'
  )

  assert.notEqual(
    config.usingComponents && config.usingComponents['ai-copilot'],
    '/components/ai-copilot/index'
  )
  assert.equal(wxml.includes('<ai-copilot'), false)
}

console.log('AI Copilot 页面接线测试全部通过')
