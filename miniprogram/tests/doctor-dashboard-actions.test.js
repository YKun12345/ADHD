const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHarness } = require('./helpers/cognitive-harness')

test('each dashboard statistic binds a real click action', () => {
  const view = fs.readFileSync(path.join(__dirname, '../pages/doctor-home/index.wxml'), 'utf8')
  for (const key of ['patients', 'reports', 'imaging', 'messages', 'tasks']) {
    assert.match(view, new RegExp(`data-stat="${key}"[^>]*bindtap="openStatistic"`))
  }
})

test('statistics open their matching users, reports, imaging, messages and tasks', async () => {
  const h = createHarness()
  try {
    h.storage.current_user.role = 'researcher'
    h.setRequest(async options => {
      if (options.url === '/doctor/dashboard_stats') return { patient_count: 2, weekly_report_count: 2, pending_imaging_count: 1 }
      if (options.url === '/doctor/my_patients') return { total: 2, items: [
        { patient_id: 8, patient_name: '甲', has_imaging: false, weekly_report_count: 2 },
        { patient_id: 9, patient_name: '乙', has_imaging: true, weekly_report_count: 0 }
      ] }
      return { unread_message_count: 0, pending_task_count: options.url.includes('/9/') ? 1 : 0 }
    })
    const navigation = []
    wx.navigateTo = options => navigation.push(options.url)
    const page = h.load('doctor-home'); await h.flush(); await h.flush()
    while (page.data.loading) await h.flush()
    const click = key => page.openStatistic({ currentTarget: { dataset: { stat: key } } })
    click('patients'); assert.equal(page.data.patients.length, 2)
    click('reports'); assert.deepEqual(page.data.patients.map(row => row.patientId), [8])
    assert.match(page.data.listTitle, /报告/)
    click('imaging'); assert.deepEqual(page.data.patients.map(row => row.patientId), [8])
    click('tasks'); assert.deepEqual(page.data.patients.map(row => row.patientId), [9])
    click('messages'); assert.equal(navigation.at(-1), '/pages/shared-messages/index')
    click('patients'); assert.equal(page.data.patients.length, 2)
    page.onHide(); click('messages'); assert.equal(navigation.length, 1, 'hidden pages cannot navigate')
  } finally { h.restore() }
})

test('missing scope is never classified as missing imaging or a recent report', () => {
  const { normalizeDashboard, filterPatients } = require('../utils/doctor-data')
  const { patients } = normalizeDashboard({}, { items: [
    { patient_id: 8, allowed_scope: ['care'], has_imaging: false, weekly_report_count: 3 },
    { patient_id: 9, allowed_scope: ['imaging', 'assessment'], has_imaging: false, weekly_report_count: 1 }
  ] })
  for (const statistic of ['imaging', 'reports']) {
    assert.deepEqual(filterPatients(patients, { statistic }).map(row => row.patientId), [9])
  }
})
