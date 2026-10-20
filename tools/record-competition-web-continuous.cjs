// Continuous capture of the real project viewer, including actual GIfTI 3D.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '..');
const work = path.join(root, '.codex-tmp/competition-recording-smooth-20261019');
const out = path.join(root, 'docs/竞赛演示视频-2026-10-19/连续操作版');
const oldWork = path.join(root, '.codex-tmp/competition-recording-20261019');
const source = JSON.parse(fs.readFileSync(path.join(root, '.codex-tmp/main-examples/source.json'), 'utf8'));
const real = JSON.parse(fs.readFileSync(path.join(oldWork, 'real-inputs.json'), 'utf8'));
const ffmpeg = fs.readdirSync(path.join(oldWork, 'media-runtime/imageio_ffmpeg/binaries'))
  .map(n => path.join(oldWork, 'media-runtime/imageio_ffmpeg/binaries', n)).find(n => n.endsWith('.exe'));
const origin = 'http://127.0.0.1:8000';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(out, { recursive: true });
const gifti = {
  'left-hemisphere-gifti-func': 'D:/数据/KKI_preproc/Gifit.func.gii/Gifit.func.gii/KKI/1018959/1018959_left.func.gii',
  'right-hemisphere-gifti-func': 'D:/数据/KKI_preproc/Gifit.func.gii/Gifit.func.gii/KKI/1018959/1018959_right.func.gii',
  'left-hemisphere-gifti-mesh': 'D:/数据/KKI_preproc/fsaverage5/fsaverage5/pial.left.gii/pial_left.surf.gii',
  'right-hemisphere-gifti-mesh': 'D:/数据/KKI_preproc/fsaverage5/fsaverage5/pial.right.gii/pial_right.surf.gii'
};

async function smoothScroll(page, selector, duration = 1600) {
  await page.evaluate(async (selector, duration) => {
    const node = document.querySelector(selector);
    if (!node) throw Error('Missing actual scroll target: ' + selector);
    const start = window.scrollY;
    const target = start + node.getBoundingClientRect().top - 110;
    await new Promise(resolve => {
      const began = performance.now();
      function step(now) {
        const t = Math.min(1, (now - began) / duration);
        const eased = t * t * (3 - 2 * t);
        window.scrollTo(0, start + (target - start) * eased);
        if (t < 1) requestAnimationFrame(step); else resolve();
      }
      requestAnimationFrame(step);
    });
  }, selector, duration);
}

async function drag(page, selector, duration, horizontal, vertical) {
  const handle = await page.$(selector);
  const box = await handle?.boundingBox();
  assert(box && box.width > 100 && box.height > 100, 'The 3D plot must be visible.');
  const x = box.x + box.width * .47, y = box.y + box.height * .52;
  await page.mouse.move(x, y); await page.mouse.down();
  const steps = Math.round(duration / 30);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(x + horizontal * t, y + vertical * Math.sin(t * Math.PI / 2));
    await pause(duration / steps);
  }
  await page.mouse.up();
}

async function captureJpegFrames(page) {
  const directory = fs.mkdtempSync(path.join(work, 'viewport-frames-'));
  const client = await page.createCDPSession();
  const frames = [];
  client.on('Page.screencastFrame', event => {
    // Acknowledge immediately. Chrome's JPEG capture and disk writes are much
    // lighter than simultaneous PNG capture + single-thread VP9 encoding.
    void client.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    const filename = String(frames.length).padStart(6, '0') + '.jpg';
    fs.writeFileSync(path.join(directory, filename), Buffer.from(event.data, 'base64'));
    frames.push({ file: filename, timestamp: event.metadata.timestamp });
  });
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  return { async stop() {
    await client.send('Page.stopScreencast');
    await pause(200);
    fs.writeFileSync(path.join(work, 'web-frame-manifest.json'), JSON.stringify({ directory, frames,
      viewport_only: true, jpeg_quality: 88, interpolated_frames: false }, null, 2));
    await client.detach();
  } };
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, userDataDir: fs.mkdtempSync(path.join(work, 'web-profile-')), protocolTimeout: 90000,
    args: ['--no-first-run', '--disable-background-networking', '--disable-sync', '--enable-unsafe-swiftshader'] });
  const errors = [], uploads = [], stages = [];
  let recording;
  let began;
  function mark(stage) { const row = { stage, seconds: (Date.now() - began) / 1000 }; stages.push(row); console.log(JSON.stringify(row)); }
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.dismiss());
    await page.setRequestInterception(true);
    page.on('request', r => {
      const url = r.url();
      if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank' || new URL(url).origin === origin) r.continue();
      else r.abort();
    });
    const doctor = source.accounts.doctor;
    await page.goto(origin + '/doctor-web/login.html', { waitUntil: 'domcontentloaded' });
    await page.click('.segment-pill[data-role="researcher"]');
    await page.type('#emailInput', doctor.email); await page.type('#passwordInput', doctor.password);
    if (!(await page.$eval('#researcherConsentCheckbox', n => n.checked))) await page.click('#researcherConsentWrap .checkmark');
    await page.waitForFunction(() => !document.querySelector('#submitBtn').disabled);
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#submitBtn')]);
    await page.goto(origin + '/doctor-web/doctor_visualization.html?patient_id=13', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__doctorVizModuleBooted && window.FINDVIZ_PATIENT_ID === 13);
    recording = await captureJpegFrames(page);
    began = Date.now(); mark('web-start');
    await pause(1200);
    await smoothScroll(page, '#upload-panel-nifti');
    await (await page.$('#nifti-func')).uploadFile(real.nifti_functional.path);
    await pause(800);
    await (await page.$('#nifti-anat')).uploadFile(real.nifti_anatomical.path);
    await pause(1000);
    let response = page.waitForResponse(r => r.url() === origin + '/findviz/upload' && r.request().method() === 'POST', { timeout: 90000 });
    await page.click('#submit-file');
    let upload = await response;
    uploads.push({ type: 'nifti', status: upload.status() }); assert.equal(upload.status(), 201, await upload.text());
    await page.waitForFunction(() => [1, 2, 3].every(i => document.getElementById('slice-' + i + '-container')?.data?.some(t => t.z?.flat().some(v => Number.isFinite(v) && v !== 0))), { timeout: 60000 });
    await page.waitForSelector('#form-opacity .slider-track', { visible: true, timeout: 15000 });
    await smoothScroll(page, '.viewer-card');
    await smoothScroll(page, '#slice-1-container');
    mark('nifti-interaction');
    const track = await (await page.$('#form-opacity .slider-track')).boundingBox();
    await page.mouse.move(track.x + track.width * .97, track.y + track.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 24; i++) { await page.mouse.move(track.x + track.width * (1 - .82 * i / 24), track.y + track.height / 2); await pause(55); }
    await page.mouse.up(); await pause(1400);
    const slice = await (await page.$('#slice-2-container .nsewdrag')).boundingBox();
    await page.mouse.move(slice.x + slice.width * .53, slice.y + slice.height * .48, { steps: 15 });
    await page.mouse.click(slice.x + slice.width * .53, slice.y + slice.height * .48);
    await pause(1400);
    // Enter a fresh viewer before changing data type: the existing page keeps
    // old NIfTI event listeners when a GIfTI viewer replaces it in place.
    // A normal reload clears those listeners; no responses or UI are mocked.
    await page.goto(origin + '/doctor-web/doctor_visualization.html?patient_id=13', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__doctorVizModuleBooted && window.FINDVIZ_PATIENT_ID === 13);
    await smoothScroll(page, '#upload-panel-gifti', 2000);
    mark('gifti-upload');
    for (const [id, filename] of Object.entries(gifti)) { await (await page.$('#' + id)).uploadFile(filename); await pause(600); }
    response = page.waitForResponse(r => r.url() === origin + '/findviz/upload' && r.request().method() === 'POST', { timeout: 90000 });
    await page.click('#submit-file-gifti');
    upload = await response;
    uploads.push({ type: 'gifti', status: upload.status() }); assert.equal(upload.status(), 201, await upload.text());
    await page.waitForFunction(() => ['left', 'right'].every(side => document.getElementById(side + '-surface-container')?.data?.some(t => t.type === 'mesh3d' && t.x?.length === 10242 && t.i?.length === 20480)), { timeout: 60000 });
    await smoothScroll(page, '#surface-container', 2000);
    await pause(1800);
    assert.equal(await page.$$eval('.modal.show', nodes => nodes.length), 0, 'An error dialog must not obscure 3D.');
    mark('3d-rotation-start');
    const before = await page.evaluate(() => document.getElementById('left-surface-container')._fullLayout.scene.camera);
    await drag(page, '#left-surface-container', 6500, 145, -50);
    await pause(800);
    await drag(page, '#right-surface-container', 6500, -150, 55);
    await pause(800);
    await drag(page, '#left-surface-container', 4500, -110, 35);
    const after = await page.evaluate(() => document.getElementById('left-surface-container')._fullLayout.scene.camera);
    assert.notDeepEqual(before, after, 'The actual 3D camera must have rotated.');
    const box = await (await page.$('#right-surface-container')).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 15; i++) { await page.mouse.wheel({ deltaY: -5 }); await pause(70); }
    await pause(900);
    for (let i = 0; i < 10; i++) { await page.mouse.wheel({ deltaY: 5 }); await pause(70); }
    await page.mouse.move(1750, 900);
    await pause(2000); mark('3d-rotation-end');
    await page.screenshot({ path: path.join(out, '真实公开数据-双半球3D表面.png') });
    await recording.stop(); recording = null;
    assert.deepEqual(errors, []);
    const meshes = await page.evaluate(() => ['left', 'right'].map(side => { const t = document.getElementById(side + '-surface-container').data.find(t => t.type === 'mesh3d'); return { side, vertices: t.x.length, triangles: t.i.length }; }));
    fs.writeFileSync(path.join(work, 'web-continuous-receipt.json'), JSON.stringify({ passed: true, continuous_capture: true,
      viewport_only: true, public_real_images: true, uploads, meshes, stages, errors, camera_before: before, camera_after: after,
      anatomical_mesh_source: 'fsaverage5 public template; not claimed as individual anatomical reconstruction',
      functional_subject: 'KKI 1018959', original_files_modified: false }, null, 2));
    console.log(JSON.stringify({ stage: 'web-complete', errors: errors.length }));
  } finally { if (recording) await recording.stop(); await browser.close(); }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
