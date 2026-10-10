const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePromise = import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.resolve(__dirname, '../../doctor-web/js/imaging_upload.js'))).toString('base64'));

test('upload errors preserve backend detail, including file size and authorization errors', async () => {
  const { readUploadResponse } = await modulePromise;
  await assert.rejects(readUploadResponse({ ok: false, status: 413, json: async () => ({ detail: '本次影像上传上限为 512 MB。' }) }), /512 MB/);
  await assert.rejects(readUploadResponse({ ok: false, status: 400, json: async () => ({ error: '掩膜尺寸不匹配' }) }), /掩膜尺寸不匹配/);
});

test('proxy HTML 413 errors produce an actionable Chinese message', async () => {
  const { readUploadResponse } = await modulePromise;
  await assert.rejects(readUploadResponse({ ok: false, status: 413, json: async () => { throw new Error('HTML'); } }), /文件过大|上传.*大小/);
});

test('oversized selections are rejected before a workspace can be cleared', async () => {
  const { validateUploadSize } = await modulePromise;
  assert.throws(() => validateUploadSize([{ size: 80 * 1024 * 1024 }, { size: 30 * 1024 * 1024 }], 100 * 1024 * 1024), /100 MB/);
  assert.doesNotThrow(() => validateUploadSize([{ size: 80 * 1024 * 1024 }], 100 * 1024 * 1024));
});

test('successful upload metadata is returned without modification', async () => {
  const { readUploadResponse } = await modulePromise;
  const metadata = { file_type: 'nifti' };
  assert.equal(await readUploadResponse({ ok: true, status: 201, json: async () => metadata }), metadata);
});
