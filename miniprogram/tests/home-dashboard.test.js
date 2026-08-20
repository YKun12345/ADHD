const assert = require('node:assert/strict')

const {
  TOTAL_DAYS,
  normalizeDashboardStatus,
  createLocalDashboard,
  buildHomeTasks,
  buildQuickEntries
} = require('../utils/home-dashboard')

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
  ['scale', 'cognitive', 'tracking', 'report']
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
  false
)

const adultEntries = buildQuickEntries('adult')
const adultScaleEntry = adultEntries.find(
  (item) => item.id === 'scale'
)
assert.equal(adultScaleEntry.available, true)
assert.equal(adultScaleEntry.url, '/pages/scale/index')

const childScaleTask = buildHomeTasks('child').find(
  (item) => item.id === 'scale'
)
assert.equal(childScaleTask.available, false)
assert.equal(childScaleTask.statusLabel, 'D5 开放')
assert.equal(Object.hasOwn(childScaleTask, 'url'), false)

console.log('患者首页进度数据测试全部通过')
