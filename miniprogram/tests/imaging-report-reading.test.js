const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { normalizeProfessionalData } = require('../utils/report-data')
const { normalizePatientReport } = require('../utils/doctor-data')
const prediction = { prediction_label: 'ADHD', probability: .95, probability_control: null, model_name: '合成历史模型',
  source_type: 'fmri_hgst', source_admission_status: 'not_recorded', professional_review_status: 'not_recorded', version_status: 'legacy_unversioned' }
test('existing historical probabilities do not invent missing control or calibrated confidence or professional approval', () => {
  const saved = normalizeProfessionalData({ latest_model_prediction: prediction })
  assert.equal(saved.adhdProbabilityText, '95.0%'); assert.equal(saved.controlProbabilityText, '--')
  assert.equal(saved.confidenceLabel, '未提供校准置信度')
  assert.match(saved.sourceStatusText, /准入.*未记录/)
  assert.match(saved.reviewStatusText, /审核.*未记录/)
  assert.match(saved.versionStatusText, /未.*不可变.*版本/)
})
test('demo remains clear to both existing pages and unshared imaging cannot retain a previous report', () => {
  const own = normalizeProfessionalData({ latest_model_prediction: { ...prediction, source_type: 'mock', is_demo: true, source_admission_status: 'demonstration_only' } })
  assert.match(own.sourceStatusText, /演示.*不用于临床/)
  const denied = normalizePatientReport({ patient_id: 8, allowed_scope: ['assessment'], latest_model_prediction: prediction })
  assert.equal(denied.professional.hasData, false)
})
test('actual doctor mini markup reads the saved body, notes, origin, recorded time and unknown review/version', () => {
  const body = fs.readFileSync(path.join(__dirname, '../pages/doctor-patient/index.wxml'), 'utf8')
  for (const name of ['imagingSummary', 'doctorNotes', 'generatedAt', 'sourceStatusText', 'reviewStatusText', 'versionStatusText']) {
    assert.ok(body.includes('report.professional.' + name), 'Saved field not readable from actual doctor page: ' + name)
  }
})

test('patient report clears saved imaging when hidden and an older same-account response cannot repaint the reopened report', async () => {
  const { createHarness } = require('./helpers/cognitive-harness'), h = createHarness()
  try {
    let finish, reads = 0
    h.setRequest(() => ++reads === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve({
      latest_model_prediction: { ...prediction, summary_text: '新打开页面读取的实际摘要。' } }))
    const page = h.load('report'); await h.flush()
    assert.equal(typeof finish, 'function')
    page.onHide()
    assert.equal(page.data.professional.hasData, false)
    await page.onShow()
    assert.equal(page.data.professional.modelSummary, '新打开页面读取的实际摘要。')
    finish({ latest_model_prediction: { ...prediction, summary_text: '迟到的旧页面摘要。' } }); await h.flush()
    assert.equal(page.data.professional.modelSummary, '新打开页面读取的实际摘要。')
    page.onHide(); assert.equal(page.data.professional.hasData, false)
  } finally { h.restore() }
})

test('saved report thumbnails accept raster data only and never open an external source or executable URL', () => {
  for (const value of ['https://external.invalid/private.png', 'javascript:alert(1)', 'data:image/svg+xml,<svg onload="x()"/>']) {
    assert.equal(normalizeProfessionalData({ latest_imaging_visualization: { slice_screenshot_data: value } }).screenshotData, '')
  }
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS4QAAAAASUVORK5CYII='
  assert.equal(normalizeProfessionalData({ latest_imaging_visualization: { slice_screenshot_data: png } }).screenshotData, png)
})
