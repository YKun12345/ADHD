const API_BASE_URL_KEY = 'api_base_url'
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8000/api/v1'

function failure(message) {
  return { value: '', error: message, environment: '' }
}

function ipv4Parts(hostname) {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null
  const numbers = parts.map(Number)
  return numbers.every((number) => number >= 0 && number <= 255)
    ? numbers
    : null
}

function localEnvironment(protocol, hostname) {
  if (protocol === 'https') return 'secure'
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'local'
  const parts = ipv4Parts(hostname)
  if (!parts) return ''
  if (parts[0] === 10) return 'lan'
  if (parts[0] === 192 && parts[1] === 168) return 'lan'
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 'lan'
  return ''
}

function normalizeApiBaseUrl(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (!text) return failure('请输入服务器地址')
  if (/[?#]/.test(text)) return failure('服务器地址不能包含查询参数或片段')

  const match = text.match(/^(https?):\/\/([^/]+)(\/.*)?$/i)
  if (!match) return failure('请输入以 http:// 或 https:// 开头的完整地址')
  const protocol = match[1].toLowerCase()
  const authority = match[2].toLowerCase()
  const path = match[3] || ''
  if (authority.includes('@')) return failure('服务器地址不能包含账号或密码')

  const authorityMatch = authority.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/)
  if (!authorityMatch) return failure('服务器主机或端口格式不正确')
  const hostname = authorityMatch[1]
  const port = authorityMatch[2]
  if (port && (Number(port) < 1 || Number(port) > 65535)) return failure('服务器端口超出范围')
  if (!ipv4Parts(hostname) && hostname !== 'localhost' && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)) {
    return failure('服务器主机格式不正确')
  }

  const environment = localEnvironment(protocol, hostname)
  if (!environment) return failure('HTTP 仅允许本机或私有局域网地址，公网请使用 HTTPS')
  if (!['', '/', '/api/v1', '/api/v1/'].includes(path)) return failure('服务器地址只能使用根路径或 /api/v1')

  return {
    value: `${protocol}://${authority}/api/v1`,
    error: '',
    environment
  }
}

function resolveApiBaseUrl(value) {
  const result = normalizeApiBaseUrl(value)
  return result.error ? DEFAULT_API_BASE_URL : result.value
}

module.exports = {
  API_BASE_URL_KEY,
  DEFAULT_API_BASE_URL,
  normalizeApiBaseUrl,
  resolveApiBaseUrl
}
