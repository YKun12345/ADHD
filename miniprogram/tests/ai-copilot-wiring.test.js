const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pageKeys = [
  'home',
  'scale',
  'cognitive-center',
  'cognitive',
  'stroop',
  'tracking',
  'tracking-trend',
  'report',
  'care-pathway',
  'education',
  'education-detail'
]

const excludedPages = [
  'login',
  'register',
  'server-settings',
  'privacy-settings',
  'ai-chat'
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
  if (pageKey === 'cognitive' || pageKey === 'stroop') {
    assert.match(
      wxml,
      new RegExp(`<ai-copilot\\s+wx:if="\\{\\{phase === 'intro' \\|\\| phase === 'result'\\}\\}"\\s+page-key="${pageKey}"\\s*/>`),
      `${pageKey} 必须仅在介绍和结果阶段渲染 ai-copilot`
    )
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
