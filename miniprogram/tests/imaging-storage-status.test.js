const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { normalizeProfessionalData, mergeReport, buildLocalReport } = require('../utils/report-data')
const { normalizePatientReport } = require('../utils/doctor-data')
const stale = { summary_text: '不得显示的旧影像正文', notes: '不得显示的旧备注' }

test('storage upgrade and conversion stay explicit without disclosing a stale body or hiding other lawful results', () => {
  for (const [status, label] of [['storage_upgrade_required', /存储.*升级/], ['conversion_required', /旧记录.*转换/], ['unexpected_future_state', /状态.*核对/]]) {
    const payload = { imaging_history_status: status, latest_imaging_visualization: stale,
      latest_model_prediction: { summary_text: '旧模型正文', probability: .9 } }
    const model = normalizeProfessionalData(payload)
    assert.equal(model.hasData, false)
    assert.equal(model.imagingSummary, '')
    assert.equal(model.modelSummary, '')
    assert.match(model.historyStatusText, label)
    const local = buildLocalReport()
    local.cognitive = { hasData: true, cards: [{ id: 'nback' }], completedCount: 1, totalCount: 6 }
    const report = mergeReport(local, payload)
    assert.equal(report.cognitive.hasData, true)
    assert.match(report.professionalData, label)
    const doctor = normalizePatientReport({ ...payload, patient_id: 10, allowed_scope: ['imaging', 'assessment'] })
    assert.match(doctor.imagingStatusText, label)
    assert.match(doctor.modelStatusText, label)
    assert.equal(doctor.hasImaging, null)
    assert.equal(doctor.hasModelPrediction, null)
  }
})

test('not authorized and no records never retain old image values, and ready does not imply professional approval', () => {
  for (const status of ['not_authorized', 'no_records']) {
    const model = normalizeProfessionalData({ imaging_history_status: status, latest_imaging_visualization: stale })
    assert.equal(model.hasData, false)
    assert.equal(model.imagingSummary, '')
  }
  const authorized = normalizeProfessionalData({ imaging_history_status: 'ready', latest_imaging_visualization: stale })
  assert.equal(authorized.imagingSummary, stale.summary_text)
  assert.match(authorized.reviewStatusText, /未记录/)
  const denied = normalizePatientReport({ patient_id: 10, allowed_scope: ['assessment'],
    imaging_history_status: 'storage_upgrade_required', latest_imaging_visualization: stale })
  assert.equal(denied.professional.hasData, false)
  assert.match(denied.professional.historyStatusText, /未共享/)
})

test('both real mini pages bind storage status independently of an available image body', () => {
  const own = fs.readFileSync(path.join(__dirname, '../pages/report/index.wxml'), 'utf8')
  const doctor = fs.readFileSync(path.join(__dirname, '../pages/doctor-patient/index.wxml'), 'utf8')
  assert.match(own, /professional\.historyStatusText/)
  assert.match(doctor, /report\.professional\.historyStatusText/)
})
