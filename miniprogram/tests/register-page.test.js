const assert = require('node:assert/strict')

const requestModulePath = require.resolve('../utils/request')
const pageModulePath = require.resolve('../pages/register/index')

let requestImplementation = async () => {
  throw new Error('request stub is not configured')
}

require.cache[requestModulePath] = {
  id: requestModulePath,
  filename: requestModulePath,
  loaded: true,
  exports: {
    request(options) {
      return requestImplementation(options)
    }
  }
}

let pageDefinition
const calls = {
  modals: [],
  navigateBack: [],
  reLaunch: [],
  request: [],
  storage: [],
  toasts: []
}
const app = {
  globalData: {
    isLoggedIn: false,
    userInfo: null
  }
}
let pageStack = [{}, {}]

global.Page = (definition) => {
  pageDefinition = definition
}
global.getApp = () => app
global.getCurrentPages = () => pageStack
global.wx = {
  navigateBack(options) {
    calls.navigateBack.push(options)
  },
  reLaunch(options) {
    calls.reLaunch.push(options)
  },
  setStorageSync(key, value) {
    calls.storage.push([key, value])
  },
  showModal(options) {
    calls.modals.push(options)
  },
  showToast(options) {
    calls.toasts.push(options)
  }
}

delete require.cache[pageModulePath]
require(pageModulePath)

function createPage() {
  const page = {
    data: {
      ...pageDefinition.data
    },
    setData(changes) {
      Object.assign(this.data, changes)
    }
  }

  for (const [name, value] of Object.entries(pageDefinition)) {
    if (typeof value === 'function') {
      page[name] = value
    }
  }

  return page
}

function resetCalls() {
  for (const value of Object.values(calls)) {
    value.length = 0
  }
}

const validForm = {
  fullName: '张三',
  email: 'patient@example.com',
  patientType: 'adult',
  age: '20',
  gender: 'female',
  password: 'BrainMap#2026',
  confirmPassword: 'BrainMap#2026',
  consentAgreed: true
}

async function run() {
  assert.deepEqual(pageDefinition.data, {
    fullName: '',
    email: '',
    patientType: '',
    age: '',
    gender: '',
    password: '',
    confirmPassword: '',
    consentAgreed: false,
    showPassword: false,
    showConfirmPassword: false,
    submitting: false
  })

  const eventPage = createPage()
  eventPage.onFieldInput({
    currentTarget: { dataset: { field: 'fullName' } },
    detail: { value: '张三' }
  })
  assert.equal(eventPage.data.fullName, '张三')

  eventPage.onPatientTypeSelect({
    currentTarget: { dataset: { value: 'child' } }
  })
  eventPage.onGenderSelect({
    currentTarget: { dataset: { value: 'undisclosed' } }
  })
  assert.equal(eventPage.data.patientType, 'child')
  assert.equal(eventPage.data.gender, 'undisclosed')

  eventPage.togglePasswordVisibility()
  eventPage.toggleConfirmPasswordVisibility()
  assert.equal(eventPage.data.showPassword, true)
  assert.equal(eventPage.data.showConfirmPassword, true)

  eventPage.onConsentChange({ detail: { value: ['agreed'] } })
  assert.equal(eventPage.data.consentAgreed, true)
  eventPage.showConsentSummary()
  assert.equal(calls.modals.length, 1)
  assert.match(calls.modals[0].content, /不替代专业医生诊断/)

  resetCalls()
  const invalidPage = createPage()
  await invalidPage.handleSubmit()
  assert.equal(calls.request.length, 0)
  assert.equal(calls.toasts.at(-1).title, '请输入患者姓名')

  resetCalls()
  const lockedPage = createPage()
  lockedPage.setData({ ...validForm, submitting: true })
  await lockedPage.handleSubmit()
  assert.equal(calls.request.length, 0)

  resetCalls()
  const successPage = createPage()
  successPage.setData(validForm)
  const responseUser = {
    id: 1,
    email: 'patient@example.com',
    full_name: '张三',
    role: 'patient'
  }
  requestImplementation = async (options) => {
    calls.request.push(options)
    return {
      access_token: 'test-token',
      token_type: 'bearer',
      user: responseUser
    }
  }

  await successPage.handleSubmit()
  assert.deepEqual(calls.request, [
    {
      url: '/auth/register',
      method: 'POST',
      data: {
        email: 'patient@example.com',
        password: 'BrainMap#2026',
        full_name: '张三',
        role: 'patient',
        consent_agreed: true,
        patient_profile: {
          age: 20,
          gender: 'female',
          patient_type: 'adult'
        }
      }
    }
  ])
  assert.deepEqual(calls.storage, [
    ['access_token', 'test-token'],
    ['current_user', responseUser]
  ])
  assert.equal(app.globalData.isLoggedIn, true)
  assert.equal(app.globalData.userInfo, responseUser)
  assert.equal(successPage.data.submitting, true)
  assert.deepEqual(calls.reLaunch.at(-1), {
    url: '/pages/home/index'
  })

  resetCalls()
  const incompletePage = createPage()
  incompletePage.setData(validForm)
  requestImplementation = async (options) => {
    calls.request.push(options)
    return { user: responseUser }
  }
  await incompletePage.handleSubmit()
  assert.equal(incompletePage.data.submitting, false)
  assert.equal(calls.storage.length, 0)
  assert.equal(calls.reLaunch.length, 0)
  assert.equal(
    calls.toasts.at(-1).title,
    '服务器未返回完整登录信息'
  )

  resetCalls()
  const rapidRetryPage = createPage()
  rapidRetryPage.setData(validForm)
  const originalDateNow = Date.now
  let currentTime = 1000
  Date.now = () => currentTime

  try {
    requestImplementation = async (options) => {
      calls.request.push(options)
      const error = new Error('This email is already registered.')
      error.statusCode = 400
      throw error
    }

    await rapidRetryPage.handleSubmit()
    currentTime = 1100
    await rapidRetryPage.handleSubmit()
    assert.equal(
      calls.request.length,
      1,
      '800毫秒内的快速重复点击只能发送一次请求'
    )

    currentTime = 1800
    await rapidRetryPage.handleSubmit()
    assert.equal(
      calls.request.length,
      2,
      '冷却时间结束后应允许用户主动重试'
    )
  } finally {
    Date.now = originalDateNow
  }

  resetCalls()
  const failedPage = createPage()
  failedPage.setData(validForm)
  requestImplementation = async (options) => {
    calls.request.push(options)
    const error = new Error('This email is already registered.')
    error.statusCode = 400
    throw error
  }
  await failedPage.handleSubmit()
  assert.equal(failedPage.data.submitting, false)
  assert.equal(failedPage.data.email, validForm.email)
  assert.equal(
    calls.toasts.at(-1).title,
    '该邮箱已经注册，请直接登录'
  )

  resetCalls()
  const navigationPage = createPage()
  pageStack = [{}, {}]
  navigationPage.goBackToLogin()
  assert.deepEqual(calls.navigateBack, [{ delta: 1 }])

  resetCalls()
  pageStack = [{}]
  navigationPage.goBackToLogin()
  assert.deepEqual(calls.reLaunch, [
    { url: '/pages/login/index' }
  ])

  console.log('注册页面控制逻辑测试全部通过')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
