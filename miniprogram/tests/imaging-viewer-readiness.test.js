const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../findviz/static/js/viewer/MainViewer.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace('export default MainViewer;', 'globalThis.MainViewer = MainViewer;');
const context = vm.createContext({ console });
vm.runInContext(source, context);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('viewer initialization waits for image, timecourse and correlation setup before reporting success', async () => {
  const image = deferred(), timecourse = deferred(), correlation = deferred();
  const viewer = { async initializeViewer() {}, initializeComponents() {}, afterUpload() {},
    viewer: { initPlot: () => image.promise }, timecourse: { initPlot: () => timecourse.promise },
    correlate: { ready: correlation.promise } };
  let finished = false;
  const initialization = context.MainViewer.prototype.init.call(viewer).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'upload success must not precede asynchronous viewer setup');
  image.resolve(); timecourse.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'correlation setup must also finish before another upload can clear the workspace');
  correlation.resolve();
  await initialization;
  assert.equal(finished, true);
});
