const assert = require('node:assert/strict')
const path = require('node:path')

const pageCases = [
  ['simple-reaction', 'handleTargetTap'],
  ['trail', 'handleNodeTap'],
  ['flanker', 'handleAnswer'],
  ['nback', 'handleAnswer'],
  ['digit-span', 'handleDigitTap']
]

for (const [pageName, answerHandler] of pageCases) {
  let pageDefinition
  global.wx = {
    getStorageSync(key) {
      if (key === 'access_token') return 'token'
      if (key === 'current_user') return { id: 7, role: 'patient', full_name: '测试患者', patient_profile: { patient_type: 'adult' } }
      return null
    },
    setStorageSync() {},
    removeStorageSync() {},
    navigateBack() {},
    navigateTo() {},
    reLaunch() {}
  }
  global.Page = (definition) => { pageDefinition = definition }
  const file = path.resolve(__dirname, `../pages/${pageName}/index.js`)
  delete require.cache[file]
  require(file)
  assert.equal(typeof pageDefinition.startTest, 'function', `${pageName} 缺少 startTest`)
  assert.equal(typeof pageDefinition[answerHandler], 'function', `${pageName} 缺少作答处理器`)
  assert.equal(typeof pageDefinition.retrySync, 'function', `${pageName} 缺少 retrySync`)
  assert.equal(typeof pageDefinition.onHide, 'function', `${pageName} 缺少 onHide`)
  assert.equal(typeof pageDefinition.onUnload, 'function', `${pageName} 缺少 onUnload`)

  const page = {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(patchValue) { this.data = { ...this.data, ...patchValue } }
  }
  page.onLoad({ mode: 'battery' })
  assert.equal(page.data.ageGroup, 'adult')
  assert.equal(page.data.mode, 'battery')
  page.startTest()
  assert.notEqual(page.data.phase, 'intro')

  if (pageName === 'flanker' || pageName === 'nback') {
    page.onUnload()
    page.setData({ running: true, phase: 'testing' })
    page._index = page._config.blockSize - 1
    page._records = []
    page._recordAnswer(
      pageName === 'flanker' ? page._trials[page._index].target : false,
      320
    )
    assert.equal(page.data.phase, 'break', `${pageName} 完成小节后应进入休息`)
    assert.equal(page.data.running, false)
    assert.equal(typeof page.continueSection, 'function')
    page.continueSection()
    assert.equal(page.data.running, true)
    assert.equal(page.data.currentTrial, page._config.blockSize + 1)
  }
  page.onUnload()
}

console.log('五个新增认知页面控制器测试全部通过')
