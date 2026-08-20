const DUPLICATE_EMAIL_DETAIL = 'This email is already registered.'

function getRegistrationErrorMessage(error) {
  if (!error) {
    return '注册失败，请稍后重试'
  }

  const message =
    typeof error.message === 'string' ? error.message : ''

  if (error.code === 'INCOMPLETE_AUTH_RESPONSE') {
    return '服务器未返回完整登录信息'
  }

  if (
    error.statusCode === 400 &&
    message === DUPLICATE_EMAIL_DETAIL
  ) {
    return '该邮箱已经注册，请直接登录'
  }

  if (error.statusCode === 422) {
    return '填写信息格式不正确，请检查后重试'
  }

  if (
    error.code === 'REQUEST_TIMEOUT' ||
    /timeout|超时/i.test(message)
  ) {
    return '请求超时，请检查网络或后端服务'
  }

  if (
    error.code === 'NETWORK_ERROR' ||
    message.includes('无法连接服务器')
  ) {
    return '无法连接服务器，请检查后端是否启动'
  }

  if (error.statusCode === 400 && message.includes('密码')) {
    return message
  }

  return '注册失败，请稍后重试'
}

module.exports = {
  getRegistrationErrorMessage
}
