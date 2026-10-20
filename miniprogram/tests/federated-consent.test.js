const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
let storage, send, calls, definition
const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true,
  exports: { request: options => { calls.push(structuredClone(options)); return send(options) } } }
const queue = require('../utils/submission-queue')
const originals = require('../utils/federated-consent-original')
const owner = { user_id: 7, role: 'patient' }
const canon = value => JSON.stringify(value)
function grant(id = 'research-one') {
  return { id, kind: 'federated_consent', route: '/federated/projects/12/consent', payload: { client_request_id: id, patient_id: 8, project_id: 12, expected_project_revision: 2, purpose: 'research', scope: ['assessment'], terms_version: 'W02-1', expires_at: null } }
}
function withdraw(id = 'research-withdraw') {
  return { id, kind: 'federated_consent_withdraw', route: '/federated/projects/12/consent/withdraw', payload: { client_request_id: id, patient_id: 8, consent_id: 31, expected_revision: 2 } }
}
function ack(item) {
  return { id: 'a'.repeat(32), actor_user_id: 7, client_request_id: item.id, original_request: structuredClone(item.payload), submission_status: 'committed', result: {
    id: 31, patient_id: 8, project_id: 12, purpose: 'research', scope: ['assessment'], status: item.kind === 'federated_consent_withdraw' ? 'withdrawn' : 'active', revision: item.kind === 'federated_consent_withdraw' ? 3 : 2, terms_version: 'W02-1', grantor_user_id: 7, expires_at: null,
    ...(item.kind === 'federated_consent' ? { project_revision: item.payload.expected_project_revision } : {}) } }
}
beforeEach(() => {
  storage = { access_token: 'synthetic-only-token', current_user: { id: 7, role: 'patient' } }; calls = []
  global.wx = { getStorageSync: key => storage[key] === undefined ? undefined : structuredClone(storage[key]),
    setStorageSync: (key, value) => { storage[key] = structuredClone(value) }, removeStorageSync: key => { delete storage[key] },
    showModal: options => options.success({ confirm: true }), reLaunch() {}, showToast() {}, navigateTo() {} }
  send = async options => ack(grant(options.data && options.data.client_request_id))
})
test('grant and withdrawal require the exact project route, own actor, body and consent version', () => {
  assert.equal(originals.valid(grant(), owner), true); assert.equal(originals.valid(withdraw(), owner), true)
  assert.equal(originals.valid(grant(), { user_id: 7, role: 'researcher' }), false)
  assert.equal(originals.valid({ ...grant(), route: '/federated/projects/13/consent' }, owner), false)
  const missingRevision = grant(); delete missingRevision.payload.expected_project_revision
  assert.equal(originals.valid(missingRevision, owner), false)
  const frozen = grant(); assert.equal(originals.matches(frozen, { ...ack(frozen), result: { ...ack(frozen).result, project_revision: 3 } }, owner, canon), false)
  assert.equal(originals.valid({ ...withdraw(), payload: { ...withdraw().payload, expected_project_revision: 2 } }, owner), false)
  for (const item of [grant(), withdraw()]) {
    assert.equal(originals.matches(item, ack(item), owner, canon), true)
    assert.equal(originals.matches(item, { ...ack(item), actor_user_id: 99 }, owner, canon), false)
    assert.equal(originals.matches(item, { ...ack(item), original_request: { ...item.payload, patient_id: 99 } }, owner, canon), false)
    assert.equal(originals.matches(item, { ...ack(item), result: { ...ack(item).result, project_id: 99 } }, owner, canon), false)
  }
  const w = withdraw(); assert.equal(originals.matches(w, { ...ack(w), result: { ...ack(w).result, revision: 2 } }, owner, canon), false)
})
test('a lost ACK preserves the exact original; GET404 never POSTs or permits archive', async () => {
  const item = grant(); queue.enqueue(item)
  send = async () => { throw new Error('synthetic lost response') }
  assert.equal(await queue.syncQueued(item.id), false)
  send = async () => { throw Object.assign(new Error('synthetic not found'), { statusCode: 404 }) }
  assert.equal(await queue.queryQueuedStatus(item.id), false)
  assert.equal(calls.at(-1).method, undefined)
  assert.equal(calls.filter(row => row.method === 'POST').length, 1)
  assert.equal(queue.canArchive(queue.allEntries()[0]), false)
  assert.deepEqual(queue.allEntries()[0].payload, item.payload)
  send = async () => ack(item)
  assert.equal(await queue.queryQueuedStatus(item.id), true); assert.deepEqual(queue.allEntries(), [])
})
test('only actual POST rejection plus fresh GET404 and explicit confirmation archives, preserving route/body', async () => {
  const item = withdraw(); queue.enqueue(item)
  send = async () => { throw Object.assign(new Error('synthetic denied'), { statusCode: 403 }) }
  assert.equal(await queue.syncQueued(item.id), false); assert.equal(queue.canArchive(queue.allEntries()[0]), false)
  send = async () => { throw Object.assign(new Error('synthetic absent'), { statusCode: 404 }) }
  await queue.queryQueuedStatus(item.id)
  assert.equal(queue.canArchive(queue.allEntries()[0]), true)
  assert.equal(queue.archiveQueued(item.id), false); assert.equal(queue.archiveQueued(item.id, { confirmed: true }), true)
  assert.deepEqual(queue.allEntries()[0].payload, item.payload)
  assert.equal(queue.allEntries()[0].route, item.route)
  assert.equal(await queue.syncQueued(item.id), false)
})
test('wrong ACK cannot remove research original; account switch ignores a late correct ACK', async () => {
  const item = grant(); queue.enqueue(item)
  send = async () => ({ ...ack(item), actor_user_id: 99 })
  assert.equal(await queue.syncQueued(item.id), false); assert.equal(queue.allEntries().length, 1)
  let finish; send = () => new Promise(resolve => { finish = resolve })
  const running = queue.queryQueuedStatus(item.id); storage.current_user.id = 99; finish(ack(item))
  assert.equal(await running, false); assert.equal(storage.submission_queue_v1.entries.length, 1)
})
function instance() {
  global.Page = value => { definition = value }
  delete require.cache[require.resolve('../pages/research-consent/index')]
  require('../pages/research-consent/index')
  return { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, structuredClone(values)) } }
}
const identity = { user_id: 7, accessible_patients: [{ patient_id: 8, display_name: '合成示例', access_kind: 'self' }] }
const context = (items = []) => ({ patient_id: 8, project: { id: 12, revision: 2, name: '合成研究', purpose: '合成方法比较', mode: 'synthetic', status: 'active', expires_at: '2027-01-01T00:00:00Z' }, items, notice: '仅此项目' })
test('actual mini page leaves every scope unchecked, requires confirmation, and reloads effective state after grant/withdraw', async () => {
  let records = [], commits = 0
  send = async options => {
    if (options.url === '/identity/context') return identity
    if (options.url.startsWith('/patient/consents')) return { items: records }
    if (options.method === 'POST') {
      commits++; const item = options.url.endsWith('/withdraw') ? withdraw(options.data.client_request_id) : grant(options.data.client_request_id)
      assert.deepEqual(options.data, item.payload)
      records = [{ ...ack(item).result, effective_access: false, effective_status: 'denied' }]
      return ack(item)
    }
    return context(records)
  }
  const page = instance(); await page.onLoad({ patient_id: '8', project_id: '12' })
  assert.deepEqual(page.data.scopes, []); assert.equal(page.data.scopeOptions.some(row => row.checked), false)
  assert.equal(await page.grant(), false); assert.equal(commits, 0)
  page.onScopeChange({ detail: { value: ['assessment'] } }); page.onAcknowledged({ detail: { value: ['read'] } })
  assert.equal(await page.grant(), true); assert.equal(commits, 1)
  assert.equal(page.data.records[0].effective_access, false); assert.match(page.data.records[0].statusLabel, /未通过/)
  assert.deepEqual(page.data.scopes, []); assert.equal(page.data.acknowledged, false)
  assert.equal(await page.withdraw({ currentTarget: { dataset: { id: 31 } } }), true)
  assert.equal(commits, 2); assert.equal(page.data.records[0].status, 'withdrawn')
})
test('hidden page clears material and ignores delayed project context; unrelated patient URL is rejected', async () => {
  let finish
  send = async options => options.url === '/identity/context' ? identity : options.url.startsWith('/patient/consents') ? { items: [] } : new Promise(resolve => { finish = resolve })
  const page = instance(), loading = page.onLoad({ patient_id: '8', project_id: '12' })
  for (let i = 0; i < 5 && !finish; i++) await Promise.resolve()
  assert.equal(typeof finish, 'function'); page.onHide(); finish(context()); await loading
  assert.equal(page.data.project, null); assert.deepEqual(page.data.records, []); assert.deepEqual(page.data.patients, [])
  const other = instance(); await other.onLoad({ patient_id: '999', project_id: '12' })
  assert.match(other.data.errorText, /不属于/); assert.equal(other.data.project, null)
})
