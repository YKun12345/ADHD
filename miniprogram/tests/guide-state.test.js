const assert = require('node:assert/strict')

const {
  buildGuideStorageKey,
  isAutoGuideEnabled,
  shouldShowOnboarding,
  markOnboardingSeen,
  shouldShowPageGuide,
  markPageGuideSeen,
  setAutoGuideEnabled,
  resetPageGuides,
  clearGuideState
} = require('../utils/guide-state')
const {
  ONBOARDING_VERSION,
  getOnboardingContent,
  getPageGuide
} = require('../utils/page-guide-content')

function createStorage() {
  const values = new Map()
  return {
    getStorageSync(key) { return values.get(key) },
    setStorageSync(key, value) { values.set(key, value) },
    removeStorageSync(key) { values.delete(key) }
  }
}

const patient = { id: 7, role: 'patient' }
const otherPatient = { id: 8, role: 'patient' }
const researcher = { id: 7, role: 'researcher' }

assert.notEqual(buildGuideStorageKey(patient), buildGuideStorageKey(otherPatient))
assert.notEqual(buildGuideStorageKey(patient), buildGuideStorageKey(researcher))

const storage = createStorage()
assert.equal(shouldShowOnboarding(patient, storage), true)
markOnboardingSeen(patient, storage)
assert.equal(shouldShowOnboarding(patient, storage), false)
clearGuideState(patient, storage)
assert.equal(shouldShowOnboarding(patient, storage), true)
assert.equal(isAutoGuideEnabled(patient, storage), true)
markOnboardingSeen(patient, storage)
assert.equal(shouldShowOnboarding(otherPatient, storage), true)
assert.equal(shouldShowOnboarding(researcher, storage), true)

assert.equal(shouldShowPageGuide(patient, 'home', storage), true)
markPageGuideSeen(patient, 'home', storage)
assert.equal(shouldShowPageGuide(patient, 'home', storage), false)
assert.equal(shouldShowPageGuide(patient, 'report', storage), true)

setAutoGuideEnabled(patient, false, storage)
assert.equal(isAutoGuideEnabled(patient, storage), false)
assert.equal(shouldShowPageGuide(patient, 'report', storage), false)
setAutoGuideEnabled(patient, true, storage)
assert.equal(shouldShowPageGuide(patient, 'report', storage), true)

markPageGuideSeen(patient, 'report', storage)
resetPageGuides(patient, storage)
assert.equal(shouldShowPageGuide(patient, 'home', storage), true)
assert.equal(shouldShowPageGuide(patient, 'report', storage), true)
assert.equal(shouldShowOnboarding(patient, storage), false)

const homeV1 = getPageGuide('home')
markPageGuideSeen(patient, 'home', storage)
assert.equal(shouldShowPageGuide(patient, 'home', storage), false)
assert.equal(shouldShowPageGuide(patient, 'home', storage, homeV1.version + 1), true)

assert.equal(ONBOARDING_VERSION >= 1, true)
assert.match(getOnboardingContent('patient').title, /ADHD 智慧辅助平台/)
assert.match(getOnboardingContent('patient').disclaimer, /不替代医生诊断/)
assert.match(getOnboardingContent('researcher').items.join(''), /电脑网页/)

for (const pageKey of [
  'home', 'scale', 'cognitive-center', 'cognitive', 'simple-reaction',
  'stroop', 'trail', 'flanker', 'nback', 'digit-span', 'tracking',
  'tracking-trend', 'report', 'patient-tasks', 'patient-messages',
  'care-pathway', 'ai-chat', 'education', 'privacy-settings',
  'doctor-home', 'doctor-patient'
]) {
  const guide = getPageGuide(pageKey)
  assert.equal(guide.pageKey, pageKey)
  assert.equal(Number.isInteger(guide.version), true)
  assert.equal(guide.intro.length >= 18 && guide.intro.length <= 45, true, `${pageKey} 文案长度异常`)
}

console.log('引导状态与本地审核文案测试全部通过')
