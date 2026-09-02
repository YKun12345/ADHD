const {
  ONBOARDING_VERSION,
  getPageGuide
} = require('./page-guide-content')

const STORAGE_PREFIX = 'guide_state_v3'

function normalizeUser(user) {
  const role = user && user.role === 'researcher' ? 'researcher' : 'patient'
  const id = Number(user && user.id)
  return {
    role,
    id: Number.isInteger(id) && id > 0 ? id : 'anonymous'
  }
}

function buildGuideStorageKey(user) {
  const identity = normalizeUser(user)
  return `${STORAGE_PREFIX}:${identity.role}:${identity.id}`
}

function storageApi(storage) {
  if (storage && typeof storage.getStorageSync === 'function') return storage
  return wx
}

function readState(user, storage) {
  const api = storageApi(storage)
  const value = api.getStorageSync(buildGuideStorageKey(user))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { autoEnabled: true, onboardingVersion: 0, pageVersions: {} }
  }
  return {
    autoEnabled: value.autoEnabled !== false,
    onboardingVersion: Number(value.onboardingVersion) || 0,
    pageVersions: value.pageVersions && typeof value.pageVersions === 'object'
      ? { ...value.pageVersions }
      : {}
  }
}

function writeState(user, state, storage) {
  storageApi(storage).setStorageSync(buildGuideStorageKey(user), state)
  return state
}

function isAutoGuideEnabled(user, storage) {
  return readState(user, storage).autoEnabled
}

function setAutoGuideEnabled(user, enabled, storage) {
  const state = readState(user, storage)
  state.autoEnabled = enabled !== false
  return writeState(user, state, storage)
}

function shouldShowOnboarding(user, storage, version = ONBOARDING_VERSION) {
  return readState(user, storage).onboardingVersion < version
}

function markOnboardingSeen(user, storage, version = ONBOARDING_VERSION) {
  const state = readState(user, storage)
  state.onboardingVersion = Math.max(state.onboardingVersion, Number(version) || 0)
  return writeState(user, state, storage)
}

function resolvePageVersion(pageKey, version) {
  return Number.isInteger(version) && version > 0
    ? version
    : getPageGuide(pageKey).version
}

function shouldShowPageGuide(user, pageKey, storage, version) {
  const state = readState(user, storage)
  if (!state.autoEnabled) return false
  const seenVersion = Number(state.pageVersions[pageKey]) || 0
  return seenVersion < resolvePageVersion(pageKey, version)
}

function markPageGuideSeen(user, pageKey, storage, version) {
  const state = readState(user, storage)
  state.pageVersions[pageKey] = resolvePageVersion(pageKey, version)
  return writeState(user, state, storage)
}

function resetPageGuides(user, storage) {
  const state = readState(user, storage)
  state.pageVersions = {}
  return writeState(user, state, storage)
}

function clearGuideState(user, storage) {
  storageApi(storage).removeStorageSync(buildGuideStorageKey(user))
}

module.exports = {
  buildGuideStorageKey,
  readGuideState: readState,
  isAutoGuideEnabled,
  shouldShowOnboarding,
  markOnboardingSeen,
  shouldShowPageGuide,
  markPageGuideSeen,
  setAutoGuideEnabled,
  resetPageGuides,
  clearGuideState
}
