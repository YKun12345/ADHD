const assert = require('node:assert/strict')
const { advancePatientDataRevision } = require('../utils/session-privacy')

const calls = {
  requests: [],
  toasts: [],
  modals: [],
  navigateBack: [],
  storageWrites: []
}
let storage = {}
let requestImplementation = async () => ({})
let pageDefinition

const requestPath = require.resolve('../utils/request')
require.cache[requestPath] = {
  id: requestPath,
  filename: requestPath,
  loaded: true,
  exports: {
    request(options) {
      calls.requests.push(options)
      return requestImplementation(options)
    }
  }
}

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  setStorageSync(key, value) {
    calls.storageWrites.push([key, value])
  },
  showToast(options) {
    calls.toasts.push(options)
  },
  showModal(options) {
    calls.modals.push(options)
    options.success({ confirm: true })
  },
  navigateBack(options) {
    calls.navigateBack.push(options)
  },
  nextTick(callback) {
    callback()
  }
}

global.Page = (definition) => {
  pageDefinition = definition
}

require('../pages/ai-chat/index.js')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createPage() {
  return {
    ...pageDefinition,
    data: clone(pageDefinition.data),
    setData(patch, callback) {
      this.data = {
        ...this.data,
        ...patch
      }
      if (callback) callback()
    }
  }
}

function reset(patientType = 'adult') {
  calls.requests = []
  calls.toasts = []
  calls.modals = []
  calls.navigateBack = []
  calls.storageWrites = []
  storage = {
    access_token: 'test-token',
    current_user: {
      id: 1,
      role: 'patient',
      full_name: 'AI 测试患者',
      patient_profile: {
        patient_type: patientType
      }
    }
  }
  requestImplementation = async () => ({
    reply: '已收到你的问题。',
    model: 'qwen-plus-latest',
    provider: 'qwen',
    disclaimer: '服务端安全提示',
    used_context: [],
    degraded: false
  })
}

function inputEvent(value) {
  return { detail: { value } }
}

function datasetEvent(dataset) {
  return { currentTarget: { dataset } }
}

async function run() {
  reset()
  requestImplementation = async () => ({
    reply: '  当前结果需要结合完整记录理解。  ',
    model: 'fallback-rule',
    provider: 'qwen',
    disclaimer: '服务端安全提示',
    used_context: ['量表', '追踪'],
    degraded: true
  })
  const page = createPage()
  page.onLoad({ scope: 'report' })
  assert.equal(page.data.patientName, 'AI 测试患者')
  assert.equal(page.data.patientType, 'adult')
  assert.equal(page.data.childNotice, false)
  assert.equal(page.data.contextScope, 'report')
  assert.equal(page.data.messages.length, 1)
  assert.equal(page.data.messages[0].role, 'guide')
  assert.equal(page.data.suggestions.length, 3)

  page.handleInput(inputEvent('  请解释量表结果  '))
  assert.equal(page.data.inputValue, '  请解释量表结果  ')
  assert.equal(page.data.inputLength, 11)
  await page.handleSend()

  assert.deepEqual(calls.requests, [{
    url: '/ai/chat',
    method: 'POST',
    data: {
      message: '请解释量表结果',
      conversation: [],
      context_scope: 'report'
    }
  }])
  assert.equal(page.data.sending, false)
  assert.equal(page.data.inputValue, '')
  assert.equal(page.data.messages.length, 3)
  assert.equal(page.data.messages[1].role, 'user')
  assert.equal(page.data.messages[1].status, 'sent')
  assert.equal(page.data.messages[2].role, 'assistant')
  assert.equal(page.data.messages[2].content, '当前结果需要结合完整记录理解。')
  assert.equal(page.data.messages[2].degraded, true)
  assert.equal(page.data.messages[2].providerLabel, '千问服务')
  assert.deepEqual(page.data.messages[2].usedContext, ['量表', '追踪'])
  assert.equal(page.data.lastDisclaimer, '服务端安全提示')
  assert.equal(page.data.scrollIntoView, 'chat-bottom')
  assert.deepEqual(calls.storageWrites, [])

  page.applySuggestion(datasetEvent({ id: 'tracking-help' }))
  assert.match(page.data.inputValue, /追踪记录/)
  assert.equal(page.data.contextScope, 'tracking')
  await page.handleSend()
  assert.equal(calls.requests.length, 2)
  assert.deepEqual(calls.requests[1].data.conversation, [
    { role: 'user', content: '请解释量表结果' },
    { role: 'assistant', content: '当前结果需要结合完整记录理解。' }
  ])
  assert.equal(calls.requests[1].data.context_scope, 'tracking')

  page.selectScope(datasetEvent({ scope: 'general' }))
  assert.equal(page.data.contextScope, 'general')
  page.selectScope(datasetEvent({ scope: 'invalid' }))
  assert.equal(page.data.contextScope, 'general')

  reset()
  const invalidPage = createPage()
  invalidPage.onLoad({})
  await invalidPage.handleSend()
  assert.equal(calls.requests.length, 0)
  assert.equal(calls.toasts.at(-1).title, '请输入想咨询的内容')
  invalidPage.handleInput(inputEvent('问'.repeat(4001)))
  await invalidPage.handleSend()
  assert.equal(calls.requests.length, 0)
  assert.equal(calls.toasts.at(-1).title, '每条消息不能超过4000字')

  reset()
  let releaseRequest
  requestImplementation = () => new Promise((resolve) => {
    releaseRequest = resolve
  })
  const guardedPage = createPage()
  guardedPage.onLoad({})
  guardedPage.handleInput(inputEvent('只发送一次'))
  const firstSend = guardedPage.handleSend()
  const secondSend = guardedPage.handleSend()
  assert.equal(calls.requests.length, 1)
  assert.equal(guardedPage.data.sending, true)
  releaseRequest({
    reply: '一次回答',
    provider: 'qwen',
    disclaimer: '安全提示'
  })
  await Promise.all([firstSend, secondSend])
  assert.equal(guardedPage.data.sending, false)
  assert.equal(
    guardedPage.data.messages.filter((item) => item.role === 'user').length,
    1
  )

  reset()
  requestImplementation = async () => {
    throw new Error('无法连接服务器，请检查后端是否启动')
  }
  const retryPage = createPage()
  retryPage.onLoad({})
  retryPage.handleInput(inputEvent('失败后重试'))
  await retryPage.handleSend()
  const failedMessage = retryPage.data.messages.find(
    (item) => item.role === 'user'
  )
  assert.equal(failedMessage.status, 'failed')
  assert.equal(retryPage.data.sending, false)
  assert.match(retryPage.data.statusMessage, /无法连接服务器/)
  assert.equal(retryPage.data.messages.some((item) => item.role === 'assistant'), false)

  requestImplementation = async () => ({
    reply: '重试成功',
    provider: 'qwen',
    disclaimer: '安全提示',
    used_context: []
  })
  await retryPage.retryMessage(datasetEvent({ id: failedMessage.id }))
  assert.equal(calls.requests.length, 2)
  assert.equal(
    retryPage.data.messages.filter((item) => item.role === 'user').length,
    1
  )
  assert.equal(
    retryPage.data.messages.find((item) => item.id === failedMessage.id).status,
    'sent'
  )
  assert.equal(retryPage.data.messages.at(-1).content, '重试成功')

  reset()
  requestImplementation = async () => ({ reply: '   ' })
  const malformedPage = createPage()
  malformedPage.onLoad({})
  malformedPage.handleInput(inputEvent('非法响应'))
  await malformedPage.handleSend()
  assert.equal(malformedPage.data.messages[1].status, 'failed')
  assert.equal(
    malformedPage.data.statusMessage,
    '服务返回内容不完整，请稍后重试'
  )

  reset('child')
  const childPage = createPage()
  childPage.onLoad({ scope: 'bad' })
  assert.equal(childPage.data.patientType, 'child')
  assert.equal(childPage.data.childNotice, true)
  assert.equal(childPage.data.contextScope, 'general')
  assert.match(childPage.data.messages[0].content, /监护人陪同/)
  assert.equal(childPage.data.suggestions.some((item) => /孩子/.test(item.text)), true)

  childPage.handleInput(inputEvent('需要清空'))
  await childPage.handleSend()
  childPage.clearConversation()
  assert.equal(calls.modals.length, 1)
  assert.equal(childPage.data.messages.length, 1)
  assert.equal(childPage.data.messages[0].role, 'guide')
  assert.equal(childPage.data.inputValue, '')
  assert.equal(childPage.data.statusMessage, '')

  childPage.goBack()
  assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

  reset()
  let releaseAfterUnload
  requestImplementation = () => new Promise((resolve) => {
    releaseAfterUnload = resolve
  })
  const unloadedPage = createPage()
  unloadedPage.onLoad({})
  unloadedPage.handleInput(inputEvent('离开页面'))
  const pending = unloadedPage.handleSend()
  const stateBeforeUnload = clone(unloadedPage.data)
  unloadedPage.onUnload()
  releaseAfterUnload({
    reply: '页面离开后的回答',
    provider: 'qwen',
    disclaimer: '安全提示'
  })
  await pending
  assert.deepEqual(unloadedPage.data, stateBeforeUnload)

  reset()
  let releaseStaleReply
  requestImplementation = () => new Promise((resolve) => {
    releaseStaleReply = resolve
  })
  const staleReplyPage = createPage()
  staleReplyPage.onLoad({})
  staleReplyPage.handleInput(inputEvent('old session question'))
  const staleReply = staleReplyPage.handleSend()
  releaseStaleReply({
    reply: 'old session answer',
    provider: 'qwen',
    disclaimer: 'old disclaimer'
  })
  advancePatientDataRevision()
  await staleReply
  assert.equal(
    staleReplyPage.data.messages.some((item) => item.role === 'assistant'),
    false
  )

  assert.equal(typeof staleReplyPage.onPatientSessionEnded, 'function')
  staleReplyPage._active = true
  staleReplyPage.onPatientSessionEnded()
  assert.equal(staleReplyPage._active, false)

  console.log('AI 助手页面控制逻辑测试全部通过')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
