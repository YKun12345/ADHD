// Capture the project webpage viewport via Chrome, never the desktop/browser UI.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '..');
const work = path.join(root, '.codex-tmp/competition-recording-20261019');
const out = path.join(root, 'docs/竞赛演示视频-2026-10-19');
const source = JSON.parse(fs.readFileSync(path.join(root, '.codex-tmp/main-examples/source.json'), 'utf8'));
const realInputs = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : null;
const assets = realInputs || source.imaging.assets;
const origin = 'http://127.0.0.1:8000';
const ffmpeg = fs.readdirSync(path.join(work, 'media-runtime/imageio_ffmpeg/binaries'))
  .map(name => path.join(work, 'media-runtime/imageio_ffmpeg/binaries', name)).find(name => name.endsWith('.exe'));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function main() {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, userDataDir: fs.mkdtempSync(path.join(work, 'web-profile-')), protocolTimeout: 90000,
    args: ['--no-first-run', '--disable-background-networking', '--disable-sync'] });
  let recording;
  const errors = [], requests = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return request.continue();
      if (new URL(url).origin === origin) return request.continue();
      return request.abort();
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/v1/') || url.pathname.startsWith('/findviz/') && !url.pathname.includes('/static/'))
        requests.push({ path: url.pathname, status: response.status() });
    });
    // Authentication is performed before recording, using the actual form.
    const doctor = source.accounts.doctor;
    await page.goto(origin + '/doctor-web/login.html', { waitUntil: 'domcontentloaded' });
    await page.click('.segment-pill[data-role="researcher"]');
    await page.type('#emailInput', doctor.email); await page.type('#passwordInput', doctor.password);
    if (!(await page.$eval('#researcherConsentCheckbox', node => node.checked))) await page.click('#researcherConsentWrap .checkmark');
    await page.waitForFunction(() => !document.querySelector('#submitBtn').disabled);
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#submitBtn')]);
    const pid = source.scenarios.followup.patient_id;
    await page.goto(origin + '/doctor-web/doctor_visualization.html?patient_id=' + pid, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__doctorVizModuleBooted && document.querySelector('#timeseriesPatientHint')?.textContent.includes('已锁定'));
    assert.equal(await page.evaluate(() => window.FINDVIZ_PATIENT_ID), pid);
    await (await page.$('#nifti-func')).uploadFile(assets.nifti_functional.path);
    await (await page.$('#nifti-anat')).uploadFile(assets.nifti_anatomical.path);
    // The capture API records page content only; no address bar or OS window.
    recording = await page.screencast({ path: path.join(work, '03-web-raw.mp4'),
      format: 'mp4', fps: 30, quality: 16, ffmpegPath: ffmpeg });
    console.log(JSON.stringify({ stage: 'web-recording-started' }));
    await pause(2500);
    const uploaded = page.waitForResponse(response => response.url() === origin + '/findviz/upload' && response.request().method() === 'POST', { timeout: 90000 });
    await page.click('#submit-file');
    assert.equal((await uploaded).status(), 201);
    await page.waitForFunction(() => [1, 2, 3].every(index => {
      const plot = document.getElementById(`slice-${index}-container`);
      return plot?.data?.some(trace => Array.isArray(trace.z) && trace.z.flat().some(value => Number.isFinite(value) && value !== 0));
    }), { timeout: 60000 });
    await pause(5000);
    await page.evaluate(() => document.querySelector('#slice-1-container')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(3500);
    const ranges = await page.$$eval('input[type=range]', elements => elements.map(element => ({ id: element.id, min: element.min, max: element.max, value: element.value })));
    if (realInputs) {
      // Use the viewer's visible controls and their normal server handlers.
      // Lower overlay opacity so the actual structural MRI remains readable.
      const opacityTrack = await page.$('#form-opacity .slider-track');
      const opacityBox = await opacityTrack.boundingBox();
      assert(opacityBox, 'The real opacity control must be visible.');
      await page.mouse.click(opacityBox.x + opacityBox.width * .18, opacityBox.y + opacityBox.height / 2);
      await pause(4000);
      const plot = await page.$('#slice-2-container .nsewdrag');
      const box = await plot?.boundingBox();
      if (box) await page.mouse.click(box.x + box.width * .54, box.y + box.height * .45);
      await pause(3000);
      const timeTrack = await page.$('#time-slider-container .slider-track');
      const timeBox = await timeTrack?.boundingBox();
      if (timeBox) await page.mouse.click(timeBox.x + timeBox.width * .15, timeBox.y + timeBox.height / 2);
      await pause(3000);
      const state = await page.evaluate(() => ({ opacity: window.jQuery('#opacity-slider').slider('getValue'),
        timepoint: window.jQuery('#time-slider').slider('getValue') }));
      assert(state.opacity < .5 && state.timepoint > 0, 'Viewer controls did not save their actual values.');
      ranges.push(state);
    } else if (ranges.length) {
      await page.$eval('input[type=range]', element => {
        const next = Math.min(Number(element.max), Number(element.value) + 2);
        element.value = String(next); element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } else {
      const plot = await page.$('#slice-1-container .nsewdrag');
      const box = await plot?.boundingBox();
      if (box) { await page.mouse.move(box.x + box.width * .35, box.y + box.height * .5); await page.mouse.down();
        await page.mouse.move(box.x + box.width * .6, box.y + box.height * .65, { steps: 25 }); await page.mouse.up(); }
    }
    await pause(5000);
    await page.screenshot({ path: path.join(out, '截图/09-网页原始影像可视化.png') });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await pause(3500);
    // Existing synthetic HGST reports concern a different input. Keep this
    // public-data viewer segment separate instead of implying correspondence.
    if (!realInputs) {
      await page.goto(origin + '/doctor-web/doctor_imaging_reports.html?patient_id=' + pid, { waitUntil: 'networkidle0' });
      await pause(4000);
      await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'smooth' })); await pause(5000);
    }
    await recording.stop(); recording = null;
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(work, 'web-receipt.json'), JSON.stringify({ status: 'passed',
      native_web_viewport_only: true, private_browser_profile: true, real_form_login: true,
      real_public_research_images: Boolean(realInputs), image_files: [assets.nifti_functional.path, assets.nifti_anatomical.path].map(p => path.basename(p)),
      real_findviz_upload_status: 201, patient_id: pid, ranges, errors, requests }, null, 2));
    console.log(JSON.stringify({ stage: 'web-recording-saved', errors: errors.length }));
  } finally { if (recording) await recording.stop(); await browser.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
