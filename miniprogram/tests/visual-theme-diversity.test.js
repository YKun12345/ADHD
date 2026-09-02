const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pagesRoot = path.join(__dirname, '..', 'pages')

const themes = Object.freeze({
  home: ['#e8f5fb', '#fff1e8'],
  scale: ['#fff0eb', '#f6efff'],
  tracking: ['#eaf8f1', '#eef8ff'],
  'tracking-trend': ['#e9f7ee', '#f3f0ff'],
  report: ['#f0edff', '#edf5ff'],
  'care-pathway': ['#eef8e9', '#fff4e5'],
  education: ['#fff6df', '#fff0dc'],
  'education-detail': ['#fff8e8', '#f7f0df'],
  'privacy-settings': ['#eef2f6', '#f5f7fa'],
  'server-settings': ['#edf2f7', '#f7f4ed'],
  login: ['#eaf6ff', '#fff3ea'],
  register: ['#f4efff', '#fff0ec'],
  'cognitive-center': ['#f0edff', '#eaf4ff'],
  'ai-chat': ['#f5efff', '#eef7ff']
})

const signatures = []

for (const [pageName, colors] of Object.entries(themes)) {
  const wxss = fs.readFileSync(
    path.join(pagesRoot, pageName, 'index.wxss'),
    'utf8'
  ).toLowerCase()

  for (const color of colors) {
    assert.equal(
      wxss.includes(color),
      true,
      `${pageName} 缺少功能分区主题色 ${color}`
    )
  }

  signatures.push(colors.join('|'))
}

assert.equal(
  new Set(signatures).size,
  signatures.length,
  '主要页面必须使用不同的背景主题签名'
)

console.log('小程序功能分区背景主题测试全部通过')
