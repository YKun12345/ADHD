const assert = require('node:assert/strict')

const {
  TOTAL_DAYS,
  normalizeDashboardStatus,
  createLocalDashboard,
  buildHomeTasks,
  buildQuickEntries
} = require('../utils/home-dashboard')
const appConfig = require('../app.json')

assert.equal(TOTAL_DAYS, 14)

assert.deepEqual(
  normalizeDashboardStatus({
    current_day: 5,
    completed_days: [3, 1, 3, 0, 15, '2'],
    total_days: 99
  }),
  {
    currentDay: 5,
    completedDays: [1, 3],
    completedCount: 2,
    totalDays: 14,
    progressPercent: 14,
    dashboardSource: 'server',
    sourceLabel: '已同步'
  }
)

assert.deepEqual(
  normalizeDashboardStatus({
    current_day: 20,
    completed_days: Array.from({ length: 14 }, (_, index) => index + 1)
  }),
  {
    currentDay: 14,
    completedDays: Array.from({ length: 14 }, (_, index) => index + 1),
    completedCount: 14,
    totalDays: 14,
    progressPercent: 100,
    dashboardSource: 'server',
    sourceLabel: '已同步'
  }
)

const emptyServerDashboard = normalizeDashboardStatus(null)
assert.equal(emptyServerDashboard.currentDay, 1)
assert.equal(emptyServerDashboard.completedCount, 0)
assert.equal(emptyServerDashboard.progressPercent, 0)

const localDashboard = createLocalDashboard({
  currentDay: 4,
  completedDays: [1, 2, 3]
})
assert.equal(localDashboard.currentDay, 4)
assert.deepEqual(localDashboard.completedDays, [1, 2, 3])
assert.equal(localDashboard.progressPercent, 21)
assert.equal(localDashboard.dashboardSource, 'local')
assert.equal(localDashboard.sourceLabel, '本地计划')

assert.equal(createLocalDashboard({}).currentDay, 1)

const tasks = buildHomeTasks()
assert.deepEqual(
  tasks.map((item) => item.id),
  ['scale', 'cognitive', 'tracking']
)
assert.equal(tasks.every((item) => item.available === false), true)
assert.equal(tasks.every((item) => item.statusLabel === '按计划开发'), true)
assert.equal(tasks.some((item) => Object.hasOwn(item, 'url')), false)

const entries = buildQuickEntries()
assert.deepEqual(
  entries.map((item) => item.id),
  ['scale', 'cognitive', 'tracking', 'report', 'ai', 'pathway', 'education']
)
assert.equal(entries.every((item) => item.available === false), true)
assert.equal(entries.every((item) => item.statusLabel === '按计划开发'), true)
assert.equal(entries.some((item) => Object.hasOwn(item, 'url')), false)

const adultTasks = buildHomeTasks('adult')
const adultScaleTask = adultTasks.find((item) => item.id === 'scale')
assert.equal(adultScaleTask.available, true)
assert.equal(adultScaleTask.statusLabel, '开始评估')
assert.equal(adultScaleTask.url, '/pages/scale/index')
assert.equal(
  adultTasks.find((item) => item.id === 'cognitive').available,
  true
)
assert.equal(
  adultTasks.find((item) => item.id === 'cognitive').statusLabel,
  '开始测试'
)
assert.equal(
  adultTasks.find((item) => item.id === 'cognitive').url,
  '/pages/cognitive-center/index'
)
assert.equal(adultTasks.find((item) => item.id === 'tracking').available, true)
assert.equal(adultTasks.find((item) => item.id === 'tracking').url, '/pages/tracking/index')

const adultEntries = buildQuickEntries('adult')
const adultScaleEntry = adultEntries.find(
  (item) => item.id === 'scale'
)
assert.equal(adultScaleEntry.available, true)
assert.equal(adultScaleEntry.url, '/pages/scale/index')
assert.equal(
  adultEntries.find((item) => item.id === 'cognitive').url,
  '/pages/cognitive-center/index'
)
const adultReportEntry = adultEntries.find((item) => item.id === 'report')
assert.equal(adultReportEntry.available, true)
assert.equal(adultReportEntry.statusLabel, '查看报告')
assert.equal(adultReportEntry.url, '/pages/report/index')
const adultAiEntry = adultEntries.find((item) => item.id === 'ai')
assert.equal(adultAiEntry.available, true)
assert.equal(adultAiEntry.statusLabel, '开始咨询')
assert.equal(adultAiEntry.url, '/pages/ai-chat/index')
assert.equal(adultTasks.some((item) => item.id === 'ai'), false)
const adultPathwayEntry = adultEntries.find((item) => item.id === 'pathway')
assert.equal(adultPathwayEntry.available, true)
assert.equal(adultPathwayEntry.statusLabel, '查看路径')
assert.equal(adultPathwayEntry.url, '/pages/care-pathway/index')
const adultEducationEntry = adultEntries.find((item) => item.id === 'education')
assert.equal(adultEducationEntry.available, true)
assert.equal(adultEducationEntry.statusLabel, '开始阅读')
assert.equal(adultEducationEntry.url, '/pages/education/index')
assert.equal(adultTasks.some((item) => item.id === 'pathway'), false)
assert.equal(adultTasks.some((item) => item.id === 'education'), false)

const childScaleTask = buildHomeTasks('child').find(
  (item) => item.id === 'scale'
)
assert.equal(childScaleTask.available, true)
assert.equal(childScaleTask.statusLabel, '开始评估')
assert.equal(childScaleTask.url, '/pages/scale/index')

const childCognitiveEntry = buildQuickEntries('child').find(
  (item) => item.id === 'cognitive'
)
assert.equal(childCognitiveEntry.available, true)
assert.equal(childCognitiveEntry.statusLabel, '开始测试')
assert.equal(childCognitiveEntry.url, '/pages/cognitive-center/index')
assert.equal(
  buildQuickEntries('child').find((item) => item.id === 'tracking').url,
  '/pages/tracking/index'
)
const childReportEntry = buildQuickEntries('child').find(
  (item) => item.id === 'report'
)
assert.equal(childReportEntry.available, true)
assert.equal(childReportEntry.statusLabel, '查看报告')
assert.equal(childReportEntry.url, '/pages/report/index')
const childAiEntry = buildQuickEntries('child').find(
  (item) => item.id === 'ai'
)
assert.equal(childAiEntry.available, true)
assert.equal(childAiEntry.statusLabel, '开始咨询')
assert.equal(childAiEntry.url, '/pages/ai-chat/index')
assert.equal(
  buildQuickEntries('child').find((item) => item.id === 'pathway').url,
  '/pages/care-pathway/index'
)
assert.equal(
  buildQuickEntries('child').find((item) => item.id === 'education').url,
  '/pages/education/index'
)

assert.equal(
  appConfig.pages.includes('pages/report/index'),
  true,
  'app.json 缺少综合报告路由'
)
assert.equal(
  appConfig.pages.includes('pages/ai-chat/index'),
  true,
  'app.json 缺少 AI 助手路由'
)
for (const route of [
  'pages/care-pathway/index',
  'pages/education/index',
  'pages/education-detail/index'
]) {
  assert.equal(appConfig.pages.includes(route), true, `app.json 缺少路由：${route}`)
}

console.log('患者首页进度数据测试全部通过')
