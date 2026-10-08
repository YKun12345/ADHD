const assert = require('node:assert/strict')
const { createHarness } = require('./helpers/cognitive-harness')
const h = createHarness()
try {
  for (const name of ['trail', 'flanker', 'nback', 'digit-span']) {
    const page = h.load(name, { mode: 'battery' })
    assert.equal(page.data.ageGroup, 'adult')
    assert.equal(page.data.mode, 'battery')
    h.start(page)
    page.onHide()
    assert.equal(page.data.running, false)
    assert.equal(page.data.phase, 'paused')
    assert.equal(h.timers.size, 0)
    page.onUnload()
  }
  console.log('四个认知页面入口、说明和中断清理测试通过')
} finally { h.restore() }
