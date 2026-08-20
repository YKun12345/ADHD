const assert = require('node:assert/strict')

const {
  getRegistrationErrorMessage
} = require('../utils/register-error')
const { createTransportError } = require('../utils/request')

function createHttpError(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

assert.equal(
  getRegistrationErrorMessage(
    createHttpError('This email is already registered.', 400)
  ),
  '该邮箱已经注册，请直接登录'
)

assert.equal(
  getRegistrationErrorMessage(
    createHttpError('[object Object]', 422)
  ),
  '填写信息格式不正确，请检查后重试'
)

assert.equal(
  getRegistrationErrorMessage(
    createHttpError(
      '密码不能为纯数字，请组合字母、数字或符号。',
      400
    )
  ),
  '密码不能为纯数字，请组合字母、数字或符号。'
)

const timeoutError = createTransportError({
  errMsg: 'request:fail timeout'
})
assert.equal(timeoutError.code, 'REQUEST_TIMEOUT')
assert.equal(
  getRegistrationErrorMessage(timeoutError),
  '请求超时，请检查网络或后端服务'
)

const networkError = createTransportError({
  errMsg: 'request:fail network error'
})
assert.equal(networkError.code, 'NETWORK_ERROR')
assert.equal(
  getRegistrationErrorMessage(networkError),
  '无法连接服务器，请检查后端是否启动'
)

const incompleteResponseError = new Error(
  '服务器未返回完整登录信息'
)
incompleteResponseError.code = 'INCOMPLETE_AUTH_RESPONSE'
assert.equal(
  getRegistrationErrorMessage(incompleteResponseError),
  '服务器未返回完整登录信息'
)

assert.equal(
  getRegistrationErrorMessage(new Error('internal detail')),
  '注册失败，请稍后重试'
)

assert.equal(
  getRegistrationErrorMessage(null),
  '注册失败，请稍后重试'
)

console.log('注册错误处理测试全部通过')
