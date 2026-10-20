const test = require('node:test')
const assert = require('node:assert/strict')

test('doctor mobile invitation never claims acceptance or opens a pending patient', async () => {
  const requests = [], toasts = []
  const requestPath = require.resolve('../utils/request')
  require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true,
    exports: { request: async (options) => {
      requests.push(options)
      if (options.method === 'POST') return { id: 9, status: 'pending', revision: 1 }
      return { items: [], total: 0 }
    } }
  }
  global.wx = {
    getStorageSync: key => key === 'access_token' ? 'synthetic-token' : key === 'current_user' ? { id: 3, role: 'researcher' } : undefined,
    showToast: value => toasts.push(value)
  }
  let definition
  global.Page = value => { definition = value }
  require('../pages/doctor-home/index')
  const page = { ...definition, data: structuredClone(definition.data),
    setData(value) { Object.assign(this.data, value) },
    loadDashboard: async () => {}
  }
  page.data.bindEmail = '  OWNER@EXAMPLE.COM  '
  await page.bindPatient()
  assert.equal(requests[0].url, '/care/relationships/invitations')
  assert.equal(requests[0].data.target_email, 'owner@example.com')
  assert.equal(page.data.bindEmail, '')
  assert.ok(toasts.some(item => /等待.*确认/.test(item.title)))
  assert.ok(toasts.every(item => !/绑定成功/.test(item.title)))
})
