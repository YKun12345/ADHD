const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const directory = path.join(__dirname, '..', 'pages', 'tracking')
const wxml = fs.readFileSync(path.join(directory, 'index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(directory, 'index.wxss'), 'utf8')
const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'))
assert.equal(appConfig.pages.includes('pages/tracking/index'), true, 'app.json 缺少 tracking 路由')
assert.equal(appConfig.pages.includes('pages/tracking-trend/index'), true, 'app.json 缺少 trend 路由')

const fragments = [
  '14天每日追踪', '{{completedCount}} / {{totalDays}}',
  "style=\"{{'width: ' + progressPercent + '%;'}}\"", 'wx:for="{{days}}"',
  'bindtap="selectDay"', 'wx:for="{{moods}}"', 'data-field="moodTag"',
  'data-field="attentionRating"', 'data-field="focusMinutes"',
  'wx:for="{{sleepOptions}}"', 'bindtap="selectSleep"',
  'bindtap="toggleMedication"', 'data-field="medicationDosage"',
  'data-field="note"', 'bindtap="submitTracking"', '{{saveStatus}}',
  'bindtap="generateDemoData"', 'bindtap="openTrend"', '查看14天趋势', '仅生成本地演示数据，不会上传服务器',
  '本追踪仅用于辅助筛查，不替代专业医生诊断或用药建议'
]
for (const fragment of fragments) assert.equal(wxml.includes(fragment), true, `WXML 缺少：${fragment}`)

const selectors = ['.tracking-page', '.tracking-nav', '.progress-card', '.day-strip', '.form-card', '.choice-button', '.choice-button--active', '.field-input', '.medication-row', '.save-button', '.demo-card', '.medical-tip']
for (const selector of selectors) assert.equal(wxss.includes(selector), true, `WXSS 缺少：${selector}`)

const saveRule = wxss.match(/\.save-button\s*\{([^}]*)\}/)
assert.ok(saveRule)
assert.match(saveRule[1], /display:\s*flex/)
assert.match(saveRule[1], /align-items:\s*center/)
assert.match(saveRule[1], /justify-content:\s*center/)
console.log('每日追踪页面视图结构测试全部通过')
