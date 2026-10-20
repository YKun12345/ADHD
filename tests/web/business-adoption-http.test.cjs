const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), net = require('node:net')
const { spawn } = require('node:child_process'), { setTimeout: pause } = require('node:timers/promises'), puppeteer = require('puppeteer-core')
const root = path.resolve(__dirname, '../..')
test('real browser profile and cycle suggestions reach exact separate human business confirmations', { timeout: 240000 }, async () => {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port
  await new Promise(resolve => probe.close(resolve)); const origin = `http://127.0.0.1:${port}`, base = origin + '/api/v1'
  const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/web/isolated_review_server.py'), String(port)],
    { cwd: root, windowsHide: true, env: { ...process.env, APP_ENV: 'test', DEEPSEEK_API_KEY: '', CARE_WORKER_ENABLED: 'false', AGENT_WORKER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let browser, page, log = ''; const errors = [], agentResponses = []
  server.stdout.on('data', value => { log += value }); server.stderr.on('data', value => { log += value })
  const api = async (route, auth, data, status = 200) => {
    const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json',
      ...(auth ? { Authorization: 'Bearer ' + auth.access_token } : {}), ...(route.startsWith('/__synthetic__/') ? { 'X-Synthetic-Test': 'w06-local-synthetic-only' } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value
  }
  try {
    for (let n = 0; n < 300; n++) { if (server.exitCode !== null) throw Error(log)
      try { if ((await fetch(origin)).ok) break } catch (_) {} if (n === 299) throw Error('Synthetic startup timeout'); await pause(100) }
    const { owner, assessment } = await api('/__synthetic__/review-source', null, { minimal: true }), pid = assessment.patient_id
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }), start = new Date(Date.parse(day + 'T00:00:00Z') - 13 * 86400000).toISOString().slice(0, 10)
    const cycle = await api('/care/cycles', owner, { patient_id: pid, client_cycle_id: 'web-adoption-cycle', start_date: start, end_date: day }, 201)
    const original = await api('/care/daily-records', owner, { patient_id: pid, cycle_id: cycle.id, record_date: day, client_submission_id: 'web-adoption-day', expected_revision: 0, content: { note: '实际合成原件，未知保持未知。' }, recorded_at: null }, 201)
    browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
      userDataDir: fs.mkdtempSync(path.join(root, '.codex-tmp/business-adoption-')), args: ['--no-first-run', '--disable-background-networking'] })
    page = await browser.newPage(); page.on('dialog', dialog => dialog.accept()); page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => { if (response.url().includes('/api/v1/agent/')) agentResponses.push({ path: new URL(response.url()).pathname, status: response.status() }) })
    await page.setViewport({ width: 430, height: 900 })
    await page.evaluateOnNewDocument(({ base, owner }) => { window.SMARTBRAIN_API_BASE_URL = base; localStorage.setItem('smartbrain_token', owner.access_token); localStorage.setItem('smartbrain_user', JSON.stringify(owner.user)) }, { base, owner })
    await page.goto(`${origin}/patient-web/patient_ai.html?patient_id=${pid}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !document.querySelector('#agentSend').disabled, { timeout: 60000 })
    await page.select('#agentIntent', 'profile_fields')
    await page.evaluate(() => {
      const text = document.querySelector('textarea[aria-label="睡眠情况"]'), status = text.parentElement.querySelector('select')
      status.value = 'provided'; status.dispatchEvent(new Event('change')); text.value = '网页本人主动提供的睡眠说明'
    })
    await page.click('#agentSend')
    await page.waitForSelector('#agentHistory a[href*="artifact_id="]', { timeout: 90000 })
    await page.click('#agentHistory a[href*="artifact_id="]'); await page.waitForSelector('input[type="checkbox"]', { timeout: 60000 })
    await page.type('[aria-label="核对原因"]', '本人逐项确认主动提供的内容与未知状态。')
    await page.$$eval('#clinicalInputs input[type="checkbox"]', nodes => nodes.forEach(node => { node.checked = true }))
    await page.evaluate(() => document.querySelector('#clinicalInputs form').requestSubmit())
    await page.waitForSelector('#clinicalHistory a[href*="patient_assessments.html"]', { timeout: 60000 })
    await page.click('#clinicalHistory a[href*="patient_assessments.html"]')
    await page.waitForFunction(() => document.querySelector('#assessmentMessage')?.textContent.includes('逐项再次核对'), { timeout: 60000 })
    await page.click('#createAssessmentButton')
    assert.ok((await page.$eval('#assessmentMessage', node => node.textContent)).includes('逐项勾选'))
    await page.$$eval('#assessmentBackground input[type="checkbox"]', nodes => nodes.forEach(node => { node.checked = true }))
    await page.click('#createAssessmentButton')
    await page.waitForFunction(() => document.querySelector('#assessmentMessage')?.textContent.includes('本轮评估已保存'), { timeout: 60000 })
    const sessions = await api(`/care/assessments?patient_id=${pid}`, owner), actual = sessions.items.find(row => row.source_ai_decision_id)
    assert.equal(actual.background.sleep.value, '网页本人主动提供的睡眠说明'); assert.equal(actual.background.medication.value, null)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the assessment form must fit its actual narrow viewport')
    await page.screenshot({ path: path.join(root, 'docs/evidence/business-adoption-profile-web.png'), fullPage: true })
    await page.goto(`${origin}/patient-web/patient_ai.html?patient_id=${pid}&cycle_id=${cycle.id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !document.querySelector('#agentSend').disabled, { timeout: 60000 }); await page.select('#agentIntent', 'cycle_summary'); await page.type('#agentInput', '请整理本次实际周期。')
    const cycleRequest = page.waitForResponse(response => response.url() === base + '/agent/runs' && response.request().method() === 'POST')
    await page.click('#agentSend')
    const cycleAck = await (await cycleRequest).json()
    const cycleSuggestion = `#agentHistory article[data-run-id="${cycleAck.run_id}"] a[href*="artifact_id="]`
    await page.waitForSelector(cycleSuggestion, { timeout: 90000 })
    await page.click(cycleSuggestion); await page.waitForSelector('[aria-label="本人核对的建议正文"]', { timeout: 60000 })
    await page.type('[aria-label="核对原因"]', '本人核对实际周期来源和覆盖。'); await page.evaluate(() => document.querySelector('#clinicalInputs form').requestSubmit())
    await page.waitForSelector('#clinicalHistory a[href*="patient_cycle_review.html"]', { timeout: 60000 }); await page.click('#clinicalHistory a[href*="patient_cycle_review.html"]')
    await page.waitForSelector('[aria-label="实际阶段复核意见"]', { timeout: 60000 }); assert.equal(await page.$eval('[aria-label="实际阶段复核意见"]', node => node.readOnly), true)
    await page.type('[aria-label="阶段材料局限"]', '覆盖汇总不能判断效果，未知不补造。'); await page.type('[aria-label="后续决定的实际原因"]', '本人明确结束这个自助周期。')
    await page.evaluate(() => document.querySelector('#clinicalInputs form').requestSubmit())
    await page.waitForFunction(() => document.querySelector('#clinicalHistory')?.textContent.includes('本人明确结束这个自助周期'), { timeout: 60000 })
    const history = await api(`/care/cycles/${cycle.id}/reviews`, owner)
    assert.equal(history.items[0].professional_confirmation, false); assert.ok(history.items[0].source_ai_decision_id)
    assert.deepEqual(await api('/care/daily-records/web-adoption-day', owner), original)
    assert.equal(await page.$$eval('pre', nodes => nodes.length), 0)
    assert.ok((await page.$eval('#clinicalInputs', node => node.textContent)).includes('记录说明：实际合成原件，未知保持未知。'))
    await page.$$eval('button', nodes => nodes.find(node => node.textContent.includes('读取这一天的全部修订原件')).click())
    await page.waitForSelector('details[open] .daily-record-fields')
    assert.equal(await page.$$eval('pre', nodes => nodes.length), 0)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the cycle and revision reader must fit the narrow viewport')
    assert.deepEqual(errors, [])
    await page.screenshot({ path: path.join(root, 'docs/evidence/business-adoption-cycle-web.png'), fullPage: true })
    console.log(JSON.stringify({ actual_chrome: true, actual_http: true, synthetic_temporary_stores: true, new_assessment_id: actual.id, background_source_decision_id: actual.source_ai_decision_id,
      cycle_review_id: history.items[0].id, cycle_source_decision_id: history.items[0].source_ai_decision_id, original_dates_unchanged: true }))
  } catch (error) {
    console.error(JSON.stringify({ synthetic_only: true, agentResponses, pageErrors: errors,
      pageText: page ? await page.evaluate(() => document.body.innerText).catch(() => '') : '', serverLog: log.slice(-3000) }))
    if (page) await page.screenshot({ path: path.join(root, 'docs/evidence/business-adoption-web-failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally { await browser?.close(); server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)]) }
})
