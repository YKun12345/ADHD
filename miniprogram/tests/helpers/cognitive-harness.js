const assert = require('node:assert/strict')

function createHarness() {
  const originals = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, now: Date.now }
  let now = 1000
  let timerId = 0
  let definition
  let requestImplementation = async () => ({ id: 1 })
  const timers = new Map()
  const requests = []
  const writes = []
  const storage = { access_token: 'test-token', current_user: { id: 7, role: 'patient', full_name: '测试患者', patient_profile: { patient_type: 'adult' } } }
  global.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay, delay }); return id }
  global.clearTimeout = (id) => timers.delete(id)
  Date.now = () => now
  global.wx = {
    getStorageSync: (key) => storage[key],
    setStorageSync(key, value) { storage[key] = value; writes.push([key, value]) },
    removeStorageSync(key) { delete storage[key] },
    nextTick: (callback) => callback(),
    navigateTo() {}, navigateBack() {}, redirectTo() {}, reLaunch() {}
  }
  global.Page = (value) => { definition = value }
  const requestPath = require.resolve('../../utils/request')
  require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true, exports: {
    request(options) { requests.push(options); return requestImplementation(options) },
    isPatientSessionError(error) { return Boolean(error && (error.code === 'SESSION_CHANGED' || error.statusCode === 401)) }
  } }
  function advance(duration) {
    const target = now + duration
    for (let count = 0; count < 10000; count++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) { now = target; return }
      timers.delete(next[0]); now = next[1].at; next[1].callback()
    }
    throw new Error('Unexpected timer loop')
  }
  function load(name, { ageGroup = 'adult', mode = 'single' } = {}) {
    storage.current_user.patient_profile.patient_type = ageGroup
    const file = require.resolve(`../../pages/${name}/index`)
    delete require.cache[file]
    require(file)
    const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback() } }
    page.onLoad({ mode })
    if (page.onShow) page.onShow()
    return page
  }
  function start(page) {
    if (!page.data.instructionVisible) page.startTest()
    advance(3000)
    assert.equal(page.data.running, false, '阅读完成后不得自动开始')
    page.handleInstructionStart()
    assert.equal(page.data.running, true)
  }
  return { load, start, advance, storage, requests, writes, timers, setRequest(fn) { requestImplementation = fn }, async flush() { await Promise.resolve(); await Promise.resolve() }, restore() { global.setTimeout = originals.setTimeout; global.clearTimeout = originals.clearTimeout; Date.now = originals.now } }
}

module.exports = { createHarness }
