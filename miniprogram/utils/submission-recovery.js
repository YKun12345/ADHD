// Recover durable submissions without adding timers or UI during cognitive runs.
const queue = require('./submission-queue')
const { hasValidRoleSession } = require('./role-session')

const COGNITIVE_ROUTES = new Set(['cognitive', 'stroop', 'flanker', 'nback', 'trail', 'digit-span']
  .map(name => `pages/${name}/index`))

function mayRecover(app, state) {
  if (app._submissionRecovery !== state || !state.foreground || !state.connected || !hasValidRoleSession('patient')) return false
  try {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    return !pages.some(page => !page._disposed && !page._hidden && page.data && page.data.running &&
      (page._taskId || COGNITIVE_ROUTES.has(String(page.route || '').replace(/^\//, ''))))
  } catch (_) { return false }
}

function retry(app, state) {
  if (!state || !mayRecover(app, state)) return Promise.resolve(0)
  if (state.flight) return state.flight
  state.flight = queue.retryPending(() => true, () => mayRecover(app, state)).catch(() => 0)
    .then(count => { state.flight = null; return count })
  return state.flight
}

function inspectNetwork(app, state) {
  if (typeof wx.getNetworkType !== 'function') return Promise.resolve(0)
  return new Promise(resolve => {
    try {
      wx.getNetworkType({
        success(value) {
          state.connected = Boolean(value && value.networkType && value.networkType !== 'none')
          resolve(retry(app, state))
        },
        fail() { state.connected = false; resolve(0) }
      })
    } catch (_) { state.connected = false; resolve(0) }
  })
}

function start(app) {
  const previous = app._submissionRecovery
  if (previous && previous.handler && typeof wx.offNetworkStatusChange === 'function') wx.offNetworkStatusChange(previous.handler)
  const state = { foreground: true, connected: false, flight: null }
  app._submissionRecovery = state
  state.handler = value => {
    state.connected = Boolean(value && value.isConnected)
    return retry(app, state)
  }
  if (typeof wx.onNetworkStatusChange === 'function') wx.onNetworkStatusChange(state.handler)
  return inspectNetwork(app, state)
}

function show(app) {
  if (!app._submissionRecovery) return start(app)
  app._submissionRecovery.foreground = true
  return inspectNetwork(app, app._submissionRecovery)
}

function hide(app) {
  if (app._submissionRecovery) app._submissionRecovery.foreground = false
}

function resume() {
  try {
    const app = typeof getApp === 'function' && getApp()
    return app && app._submissionRecovery ? retry(app, app._submissionRecovery) : Promise.resolve(0)
  } catch (_) { return Promise.resolve(0) }
}

module.exports = { start, show, hide, resume }
