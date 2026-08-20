# 微信小程序患者注册 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成原生微信小程序的患者注册闭环：成人或儿童填写信息、通过本地校验、按 FastAPI 契约提交、正确处理错误，并在成功后保存登录状态进入患者首页。

**Architecture:** 保持页面、纯业务模块和网络层分离。`pages/register/index.js` 只编排页面事件与提交流程；校验、请求载荷构造和错误翻译分别放在可由 Node 直接测试的 CommonJS 模块中；`utils/request.js` 继续统一处理 HTTP 与传输层错误。页面结构与样式分别由 WXML/WXSS 承担，并使用静态契约测试加微信开发者工具手工检查共同验证。

**Tech Stack:** 原生微信小程序（WXML、WXSS、CommonJS JavaScript）、微信 `wx` API、Node.js 内置 `node:assert/strict`、FastAPI 现有注册契约、Git。

---

## 执行规则（开始任何实现前先读）

1. 保留当前全部未提交文件；严禁 `git reset --hard`、`git checkout --` 和删除现有改动。
2. 严格按任务顺序执行；每个行为先写测试、运行并看到预期失败，再写最小实现，再运行到通过。
3. 每次只让项目成员 A 完成一个很小的操作。给出一条命令或一次微信开发者工具点击后，先等待 A 返回结果，再继续。
4. 所有命令都从仓库根目录 `C:\Users\Lenovo\Desktop\源码` 运行；PowerShell 提示符所在目录不对时先执行：

```powershell
Set-Location -LiteralPath 'C:\Users\Lenovo\Desktop\源码'
```

5. 每次提交只用精确路径 `git add`；提交前运行 `git diff --cached --name-only`，确认没有无关文件。
6. 不记录或展示明文密码、token、完整注册请求，也不把后端“已有代码”表述成“已完成真实联调”。
7. 自动化测试通过不等于微信页面已经通过；WXML/WXSS 必须再由微信开发者工具编译和手工检查。

## 文件职责与变更地图

| 路径 | 操作 | 单一职责 |
| --- | --- | --- |
| `miniprogram/app.json` | 保留并提交现有修改 | 注册页面路由 |
| `miniprogram/pages/login/index.js` | 保留并提交现有修改 | 从登录页导航到注册页 |
| `miniprogram/pages/login/index.wxml` | 保留并提交现有修改 | 可点击的注册入口 |
| `miniprogram/utils/register-validation.js` | 修改 | 纯表单校验，返回第一条中文错误 |
| `miniprogram/tests/register-validation.test.js` | 修改 | 校验边界、弱密码和合法成人/儿童用例 |
| `miniprogram/utils/register-payload.js` | 新建 | 把已校验页面状态转换为后端请求体 |
| `miniprogram/tests/register-payload.test.js` | 新建 | 请求体字段、转换和敏感页面状态排除 |
| `miniprogram/utils/register-error.js` | 新建 | 注册业务错误翻译 |
| `miniprogram/tests/register-error.test.js` | 新建 | 重复邮箱、422、密码、网络、超时及未知错误 |
| `miniprogram/utils/request.js` | 小幅修改 | 给网络失败和超时设置稳定错误码 |
| `miniprogram/pages/register/index.js` | 替换占位实现 | 页面状态、事件、提交、存储和导航 |
| `miniprogram/tests/register-page.test.js` | 新建 | 在 Node 中模拟 `Page`/`wx`，验证页面控制逻辑 |
| `miniprogram/pages/register/index.wxml` | 替换占位结构 | 完整注册表单结构 |
| `miniprogram/pages/register/index.wxss` | 替换占位样式 | 分区单页视觉与滚动布局 |
| `miniprogram/tests/register-view.test.js` | 新建 | WXML/WXSS 静态契约与占位内容清除检查 |

### Task 1: 固化已经验证的注册路由和登录入口

**Files:**
- Modify (already present; do not rewrite): `miniprogram/app.json`
- Modify (already present; do not rewrite): `miniprogram/pages/login/index.js`
- Modify (already present; do not rewrite): `miniprogram/pages/login/index.wxml`
- Create (already present as placeholder; preserve): `miniprogram/pages/register/index.js`
- Create (already present): `miniprogram/pages/register/index.json`
- Create (already present as placeholder; preserve): `miniprogram/pages/register/index.wxml`
- Create (already present as placeholder; preserve): `miniprogram/pages/register/index.wxss`

- [ ] **Step 1: 再次确认工作区只包含预期的现有改动**

Run:

```powershell
git status --short
```

Expected: 至少仍看到以下路径；不能比基线少，也不能因为本计划出现小程序文件被删除：

```text
 M miniprogram/app.json
 M miniprogram/pages/login/index.js
 M miniprogram/pages/login/index.wxml
?? miniprogram/pages/register/
?? miniprogram/tests/
?? miniprogram/utils/register-validation.js
?? docs/superpowers/plans/2026-08-20-miniprogram-patient-registration.md
```

- [ ] **Step 2: 验证现有入口文件仍可解析且校验基线仍通过**

Run:

```powershell
node --check miniprogram/pages/login/index.js
node --check miniprogram/pages/register/index.js
node miniprogram/tests/register-validation.test.js
git diff --check
```

Expected: 两个 `node --check` 无输出且退出码为 0；测试打印 `注册表单校验测试全部通过`；`git diff --check` 无输出。

- [ ] **Step 3: 只暂存注册路由、登录入口和能被路由打开的占位页面**

Run:

```powershell
git add miniprogram/app.json miniprogram/pages/login/index.js miniprogram/pages/login/index.wxml miniprogram/pages/register/index.js miniprogram/pages/register/index.json miniprogram/pages/register/index.wxml miniprogram/pages/register/index.wxss
git diff --cached --name-only
```

Expected: 只列出上面 7 个精确路径；不能出现 `miniprogram/tests/`、`register-validation.js` 或其他文件。

- [ ] **Step 4: 提交已验证入口**

Run:

```powershell
git commit -m "feat(miniprogram): add patient registration entry"
```

Expected: 创建 1 个提交。提交后 `register-validation.js` 和现有测试仍应保持未跟踪，不能被丢失。

### Task 2: 用失败测试补齐注册表单校验

**Files:**
- Modify: `miniprogram/tests/register-validation.test.js`
- Modify: `miniprogram/utils/register-validation.js`

- [ ] **Step 1: 先把校验测试替换为完整边界测试**

Replace `miniprogram/tests/register-validation.test.js` with:

```js
const assert = require('node:assert/strict')

const {
  COMMON_WEAK_PASSWORDS,
  validateRegistration
} = require('../utils/register-validation')

const expectedWeakPasswords = [
  '12345678',
  '123456789',
  '1234567890',
  '00000000',
  '11111111',
  '123123123',
  '87654321',
  'password',
  'password123',
  'admin123',
  'qwerty123',
  'qwertyuiop',
  'asdfghjk',
  'abcd1234',
  'welcome123',
  'iloveyou',
  '1q2w3e4r',
  'aa123456'
]

const validAdultForm = {
  fullName: '张三',
  email: 'patient@example.com',
  patientType: 'adult',
  age: '20',
  gender: 'undisclosed',
  password: 'BrainMap#2026',
  confirmPassword: 'BrainMap#2026',
  consentAgreed: true
}

const validChildForm = {
  ...validAdultForm,
  fullName: '李小明',
  email: 'child@example.com',
  patientType: 'child',
  age: '10'
}

function expectError(changes, expectedMessage) {
  const result = validateRegistration({
    ...validAdultForm,
    ...changes
  })

  assert.equal(result, expectedMessage)
}

assert.deepEqual(COMMON_WEAK_PASSWORDS, expectedWeakPasswords)

expectError({ fullName: '' }, '请输入患者姓名')
expectError({ fullName: '张' }, '患者姓名至少需要2个字符')
expectError({ fullName: '张'.repeat(101) }, '患者姓名不能超过100个字符')
expectError({ email: 'wrong-email' }, '请输入正确的邮箱地址')

expectError(
  { password: 'Abc123', confirmPassword: 'Abc123' },
  '密码长度不能少于8位'
)
expectError(
  { password: 'A'.repeat(129), confirmPassword: 'A'.repeat(129) },
  '密码长度不能超过128位'
)
expectError(
  { password: '87654321', confirmPassword: '87654321' },
  '密码不能为纯数字'
)

for (const password of COMMON_WEAK_PASSWORDS) {
  const expectedMessage = /^\d+$/.test(password)
    ? '密码不能为纯数字'
    : '当前密码过于常见'

  expectError({ password, confirmPassword: password }, expectedMessage)
}

expectError(
  { confirmPassword: 'Different#2026' },
  '两次输入的密码不一致'
)
expectError({ patientType: '' }, '请选择患者类型')
expectError({ patientType: 'teenager' }, '患者类型不正确')

for (const age of ['', '1.5', 'abc', '0', '121']) {
  expectError({ age }, '年龄必须是1至120之间的整数')
}

expectError(
  { consentAgreed: false },
  '请阅读并同意知情同意说明'
)
expectError(
  { consentAgreed: 'true' },
  '请阅读并同意知情同意说明'
)

assert.equal(validateRegistration(validAdultForm), '')
assert.equal(validateRegistration(validChildForm), '')

console.log('注册表单校验测试全部通过')
```

- [ ] **Step 2: 运行测试并确认它以正确原因失败**

Run:

```powershell
node miniprogram/tests/register-validation.test.js
```

Expected: FAIL。第一处失败应指出 `COMMON_WEAK_PASSWORDS` 未导出、弱密码集合不一致或单字符姓名没有被拒绝；不能是语法错误或路径错误。

- [ ] **Step 3: 写最小校验实现使全部新用例通过**

Replace `miniprogram/utils/register-validation.js` with:

```js
const COMMON_WEAK_PASSWORDS = [
  '12345678',
  '123456789',
  '1234567890',
  '00000000',
  '11111111',
  '123123123',
  '87654321',
  'password',
  'password123',
  'admin123',
  'qwerty123',
  'qwertyuiop',
  'asdfghjk',
  'abcd1234',
  'welcome123',
  'iloveyou',
  '1q2w3e4r',
  'aa123456'
]

function validateRegistration(form = {}) {
  const fullName = String(form.fullName || '').trim()
  const email = String(form.email || '').trim()
  const patientType = form.patientType || ''
  const age = String(form.age ?? '').trim()
  const password = String(form.password || '')
  const confirmPassword = String(form.confirmPassword || '')

  if (!fullName) {
    return '请输入患者姓名'
  }

  if (fullName.length < 2) {
    return '患者姓名至少需要2个字符'
  }

  if (fullName.length > 100) {
    return '患者姓名不能超过100个字符'
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

  if (!emailPattern.test(email)) {
    return '请输入正确的邮箱地址'
  }

  if (password.length < 8) {
    return '密码长度不能少于8位'
  }

  if (password.length > 128) {
    return '密码长度不能超过128位'
  }

  if (/^\d+$/.test(password)) {
    return '密码不能为纯数字'
  }

  if (COMMON_WEAK_PASSWORDS.includes(password.toLowerCase())) {
    return '当前密码过于常见'
  }

  if (password !== confirmPassword) {
    return '两次输入的密码不一致'
  }

  if (!patientType) {
    return '请选择患者类型'
  }

  if (!['adult', 'child'].includes(patientType)) {
    return '患者类型不正确'
  }

  const ageNumber = Number(age)

  if (
    !age ||
    !Number.isInteger(ageNumber) ||
    ageNumber < 1 ||
    ageNumber > 120
  ) {
    return '年龄必须是1至120之间的整数'
  }

  if (form.consentAgreed !== true) {
    return '请阅读并同意知情同意说明'
  }

  return ''
}

module.exports = {
  COMMON_WEAK_PASSWORDS,
  validateRegistration
}
```

- [ ] **Step 4: 运行校验测试与语法检查**

Run:

```powershell
node miniprogram/tests/register-validation.test.js
node --check miniprogram/utils/register-validation.js
node --check miniprogram/tests/register-validation.test.js
git diff --check
```

Expected: 打印 `注册表单校验测试全部通过`；其余命令无输出且退出码为 0。

- [ ] **Step 5: 精确暂存并提交校验模块**

Run:

```powershell
git add miniprogram/utils/register-validation.js miniprogram/tests/register-validation.test.js
git diff --cached --name-only
git commit -m "test(miniprogram): align registration validation"
```

Expected: 暂存清单只有两个路径，并创建独立提交。

### Task 3: 用失败测试创建后端请求载荷转换模块

**Files:**
- Create: `miniprogram/tests/register-payload.test.js`
- Create: `miniprogram/utils/register-payload.js`

- [ ] **Step 1: 先创建请求载荷测试**

Create `miniprogram/tests/register-payload.test.js`:

```js
const assert = require('node:assert/strict')

const {
  buildRegistrationPayload
} = require('../utils/register-payload')

const adultPayload = buildRegistrationPayload({
  fullName: '  张三  ',
  email: '  Patient@Example.COM  ',
  patientType: 'adult',
  age: '20',
  gender: 'female',
  password: 'BrainMap#2026',
  confirmPassword: 'BrainMap#2026',
  consentAgreed: true,
  showPassword: true,
  showConfirmPassword: true,
  submitting: true
})

assert.deepEqual(adultPayload, {
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
})

const childPayload = buildRegistrationPayload({
  fullName: '李小明',
  email: 'child@example.com',
  patientType: 'child',
  age: '10',
  gender: '',
  password: 'ChildSafe#2026',
  confirmPassword: 'ChildSafe#2026',
  consentAgreed: true,
  showPassword: false,
  showConfirmPassword: false,
  submitting: false
})

assert.deepEqual(childPayload.patient_profile, {
  age: 10,
  gender: null,
  patient_type: 'child'
})

for (const excludedField of [
  'confirmPassword',
  'showPassword',
  'showConfirmPassword',
  'submitting'
]) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(adultPayload, excludedField),
    false
  )
}

console.log('注册请求数据转换测试全部通过')
```

- [ ] **Step 2: 运行测试并确认模块缺失导致失败**

Run:

```powershell
node miniprogram/tests/register-payload.test.js
```

Expected: FAIL with `Cannot find module '../utils/register-payload'`。

- [ ] **Step 3: 创建最小请求载荷转换实现**

Create `miniprogram/utils/register-payload.js`:

```js
function buildRegistrationPayload(form = {}) {
  return {
    email: String(form.email || '').trim().toLowerCase(),
    password: String(form.password || ''),
    full_name: String(form.fullName || '').trim(),
    role: 'patient',
    consent_agreed: form.consentAgreed === true,
    patient_profile: {
      age: Number(form.age),
      gender: form.gender || null,
      patient_type: form.patientType
    }
  }
}

module.exports = {
  buildRegistrationPayload
}
```

- [ ] **Step 4: 运行测试和语法检查**

Run:

```powershell
node miniprogram/tests/register-payload.test.js
node --check miniprogram/utils/register-payload.js
node --check miniprogram/tests/register-payload.test.js
git diff --check
```

Expected: 打印 `注册请求数据转换测试全部通过`；其余命令无输出且退出码为 0。

- [ ] **Step 5: 精确暂存并提交**

Run:

```powershell
git add miniprogram/utils/register-payload.js miniprogram/tests/register-payload.test.js
git diff --cached --name-only
git commit -m "feat(miniprogram): build patient registration payload"
```

Expected: 暂存清单只有两个路径，并创建独立提交。

### Task 4: 用失败测试实现传输错误标记和注册业务错误翻译

**Files:**
- Create: `miniprogram/tests/register-error.test.js`
- Create: `miniprogram/utils/register-error.js`
- Modify: `miniprogram/utils/request.js`

- [ ] **Step 1: 先创建错误处理测试**

Create `miniprogram/tests/register-error.test.js`:

```js
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
```

- [ ] **Step 2: 运行测试并确认它因模块或导出缺失而失败**

Run:

```powershell
node miniprogram/tests/register-error.test.js
```

Expected: FAIL with `Cannot find module '../utils/register-error'`。创建该文件后再次运行时，还应因 `createTransportError` 未实现而失败。

- [ ] **Step 3: 创建注册业务错误映射模块**

Create `miniprogram/utils/register-error.js`:

```js
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
```

- [ ] **Step 4: 给统一请求层增加可测试的超时/网络错误码**

In `miniprogram/utils/request.js`, add this function immediately after `BASE_URL`:

```js
function createTransportError(error = {}) {
  const detail =
    typeof error.errMsg === 'string' ? error.errMsg : ''
  const isTimeout = /timeout/i.test(detail)
  const requestError = new Error(
    isTimeout
      ? '请求超时，请检查网络或后端服务'
      : '无法连接服务器，请检查后端是否启动'
  )

  requestError.code = isTimeout
    ? 'REQUEST_TIMEOUT'
    : 'NETWORK_ERROR'

  return requestError
}
```

Replace only the existing `fail(error)` body with:

```js
      fail(error) {
        console.error('网络请求失败：', error)
        reject(createTransportError(error))
      }
```

Replace the final export with:

```js
module.exports = {
  request,
  BASE_URL,
  createTransportError
}
```

Do not change the base URL, 10-second timeout, Bearer token behavior, HTTP handling, or 401 cleanup in this task.

- [ ] **Step 5: 运行错误测试、既有测试和语法检查**

Run:

```powershell
node miniprogram/tests/register-error.test.js
node miniprogram/tests/register-validation.test.js
node --check miniprogram/utils/register-error.js
node --check miniprogram/utils/request.js
node --check miniprogram/tests/register-error.test.js
git diff --check
```

Expected: 分别打印 `注册错误处理测试全部通过` 和 `注册表单校验测试全部通过`；语法与空白检查无输出。

- [ ] **Step 6: 精确暂存并提交错误处理**

Run:

```powershell
git add miniprogram/utils/register-error.js miniprogram/utils/request.js miniprogram/tests/register-error.test.js
git diff --cached --name-only
git commit -m "feat(miniprogram): map registration errors"
```

Expected: 暂存清单只有三个路径，并创建独立提交。

### Task 5: 先测试页面控制逻辑，再实现注册页面 JavaScript

**Files:**
- Create: `miniprogram/tests/register-page.test.js`
- Modify: `miniprogram/pages/register/index.js`

- [ ] **Step 1: 创建微信页面控制逻辑的 Node 测试环境**

Create `miniprogram/tests/register-page.test.js`:

```js
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
```

- [ ] **Step 2: 运行测试并确认占位页面导致失败**

Run:

```powershell
node miniprogram/tests/register-page.test.js
```

Expected: FAIL，因为当前 `Page({})` 没有 `data` 或 `handleSubmit`。失败必须来自缺失页面逻辑，而不是测试语法或模块路径。

- [ ] **Step 3: 实现完整页面状态、事件和提交流程**

Replace `miniprogram/pages/register/index.js` with:

```js
const { request } = require('../../utils/request')
const {
  validateRegistration
} = require('../../utils/register-validation')
const {
  buildRegistrationPayload
} = require('../../utils/register-payload')
const {
  getRegistrationErrorMessage
} = require('../../utils/register-error')

const EDITABLE_FIELDS = [
  'fullName',
  'email',
  'age',
  'password',
  'confirmPassword'
]

Page({
  data: {
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
  },

  onFieldInput(event) {
    const field = event.currentTarget.dataset.field

    if (!EDITABLE_FIELDS.includes(field)) {
      return
    }

    this.setData({
      [field]: event.detail.value
    })
  },

  onPatientTypeSelect(event) {
    this.setData({
      patientType: event.currentTarget.dataset.value
    })
  },

  onGenderSelect(event) {
    this.setData({
      gender: event.currentTarget.dataset.value
    })
  },

  togglePasswordVisibility() {
    this.setData({
      showPassword: !this.data.showPassword
    })
  },

  toggleConfirmPasswordVisibility() {
    this.setData({
      showConfirmPassword: !this.data.showConfirmPassword
    })
  },

  onConsentChange(event) {
    this.setData({
      consentAgreed: event.detail.value.includes('agreed')
    })
  },

  showConsentSummary() {
    wx.showModal({
      title: '知情同意说明摘要',
      content:
        '平台会收集账号资料、患者基础资料、量表、认知测试和追踪数据，用于辅助筛查、任务安排和报告生成。平台结果不替代专业医生诊断。当前竞赛版本的正式文本仍需指导老师或相关专业人员审核。',
      showCancel: false,
      confirmText: '我知道了'
    })
  },

  goBackToLogin() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack({
        delta: 1
      })
      return
    }

    wx.reLaunch({
      url: '/pages/login/index'
    })
  },

  async handleSubmit() {
    if (this.data.submitting) {
      return
    }

    const validationMessage = validateRegistration(this.data)

    if (validationMessage) {
      wx.showToast({
        title: validationMessage,
        icon: 'none',
        duration: 2500
      })
      return
    }

    this.setData({
      submitting: true
    })

    try {
      const result = await request({
        url: '/auth/register',
        method: 'POST',
        data: buildRegistrationPayload(this.data)
      })

      if (!result || !result.access_token || !result.user) {
        const error = new Error('服务器未返回完整登录信息')
        error.code = 'INCOMPLETE_AUTH_RESPONSE'
        throw error
      }

      wx.setStorageSync('access_token', result.access_token)
      wx.setStorageSync('current_user', result.user)

      const app = getApp()
      app.globalData.isLoggedIn = true
      app.globalData.userInfo = result.user

      wx.showToast({
        title: '注册成功',
        icon: 'success'
      })

      wx.reLaunch({
        url: '/pages/home/index'
      })
    } catch (error) {
      this.setData({
        submitting: false
      })

      wx.showToast({
        title: getRegistrationErrorMessage(error),
        icon: 'none',
        duration: 2500
      })
    }
  }
})
```

- [ ] **Step 4: 运行页面控制测试及所有已有 Node 测试**

Run:

```powershell
node miniprogram/tests/register-page.test.js
node miniprogram/tests/register-error.test.js
node miniprogram/tests/register-payload.test.js
node miniprogram/tests/register-validation.test.js
node --check miniprogram/pages/register/index.js
git diff --check
```

Expected: 四个测试依次打印“全部通过”；语法与空白检查无输出。成功用例中的 `submitting` 必须保持 `true`，失败用例必须恢复为 `false`。

- [ ] **Step 5: 精确暂存并提交页面控制逻辑**

Run:

```powershell
git add miniprogram/pages/register/index.js miniprogram/tests/register-page.test.js
git diff --cached --name-only
git commit -m "feat(miniprogram): implement registration page logic"
```

Expected: 暂存清单只有两个路径，并创建独立提交。

### Task 6: 先写结构契约测试，再实现完整 WXML

**Files:**
- Create: `miniprogram/tests/register-view.test.js`
- Modify: `miniprogram/pages/register/index.wxml`

- [ ] **Step 1: 创建 WXML 静态契约测试**

Create `miniprogram/tests/register-view.test.js`:

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const registerDirectory = path.join(
  __dirname,
  '..',
  'pages',
  'register'
)
const wxml = fs.readFileSync(
  path.join(registerDirectory, 'index.wxml'),
  'utf8'
)

const requiredWxmlSnippets = [
  'bindsubmit="handleSubmit"',
  'data-field="fullName"',
  'data-field="age"',
  'type="number"',
  'data-value="adult"',
  'data-value="child"',
  'data-value="male"',
  'data-value="female"',
  'data-value="other"',
  'data-value="undisclosed"',
  'data-field="email"',
  'data-field="password"',
  'data-field="confirmPassword"',
  'password="{{!showPassword}}"',
  'password="{{!showConfirmPassword}}"',
  'bindchange="onConsentChange"',
  'bindtap="showConsentSummary"',
  'loading="{{submitting}}"',
  'disabled="{{submitting}}"',
  'bindtap="goBackToLogin"',
  '本平台仅用于辅助筛查，不替代专业医生诊断'
]

for (const snippet of requiredWxmlSnippets) {
  assert.equal(
    wxml.includes(snippet),
    true,
    `WXML 缺少：${snippet}`
  )
}

assert.equal(
  (wxml.match(/class="register-card"/g) || []).length,
  2,
  '注册页必须恰好包含患者信息和账号安全两个卡片'
)
assert.equal(
  wxml.includes('注册表单将在下一步填写'),
  false,
  '必须删除占位文案'
)

console.log('注册页面结构测试全部通过')
```

- [ ] **Step 2: 运行测试并确认占位 WXML 导致失败**

Run:

```powershell
node miniprogram/tests/register-view.test.js
```

Expected: FAIL，并明确提示第一个缺少的表单绑定；不能是文件路径或 JavaScript 语法错误。

- [ ] **Step 3: 替换为完整分区单页 WXML**

Replace `miniprogram/pages/register/index.wxml` with:

```xml
<view class="register-page">
  <view class="register-header">
    <text class="register-title">创建患者账号</text>
    <text class="register-subtitle">
      完善基础信息，开始14天辅助筛查计划
    </text>
  </view>

  <form bindsubmit="handleSubmit">
    <view class="register-card">
      <text class="section-title">患者信息</text>
      <text class="section-description">
        请填写接受辅助筛查的患者资料
      </text>

      <view class="field-block">
        <text class="field-label">患者姓名</text>
        <input
          class="field-input"
          type="text"
          maxlength="100"
          value="{{fullName}}"
          placeholder="请输入患者姓名"
          placeholder-class="input-placeholder"
          data-field="fullName"
          bindinput="onFieldInput"
        />
      </view>

      <view class="field-block">
        <text class="field-label">患者类型</text>
        <text class="field-help">请主动选择，不根据年龄自动判断</text>
        <view class="choice-grid patient-type-grid">
          <view
            class="choice-card {{patientType === 'adult' ? 'choice-card--active' : ''}}"
            data-value="adult"
            bindtap="onPatientTypeSelect"
          >
            <text class="choice-title">成人患者</text>
            <text class="choice-description">成人量表与任务</text>
          </view>
          <view
            class="choice-card {{patientType === 'child' ? 'choice-card--active' : ''}}"
            data-value="child"
            bindtap="onPatientTypeSelect"
          >
            <text class="choice-title">儿童患者</text>
            <text class="choice-description">儿童量表与任务</text>
          </view>
        </view>
      </view>

      <view class="field-block">
        <text class="field-label">年龄</text>
        <input
          class="field-input"
          type="number"
          maxlength="3"
          value="{{age}}"
          placeholder="请输入1至120之间的整数"
          placeholder-class="input-placeholder"
          data-field="age"
          bindinput="onFieldInput"
        />
      </view>

      <view class="field-block">
        <text class="field-label">性别（选填）</text>
        <view class="gender-grid">
          <view
            class="gender-option {{gender === 'male' ? 'gender-option--active' : ''}}"
            data-value="male"
            bindtap="onGenderSelect"
          >男</view>
          <view
            class="gender-option {{gender === 'female' ? 'gender-option--active' : ''}}"
            data-value="female"
            bindtap="onGenderSelect"
          >女</view>
          <view
            class="gender-option {{gender === 'other' ? 'gender-option--active' : ''}}"
            data-value="other"
            bindtap="onGenderSelect"
          >其他</view>
          <view
            class="gender-option {{gender === 'undisclosed' ? 'gender-option--active' : ''}}"
            data-value="undisclosed"
            bindtap="onGenderSelect"
          >不愿透露</view>
        </view>
      </view>
    </view>

    <view class="register-card">
      <text class="section-title">账号安全</text>
      <text class="section-description">
        使用邮箱和安全密码创建患者账号
      </text>

      <view class="field-block">
        <text class="field-label">邮箱</text>
        <input
          class="field-input"
          type="text"
          maxlength="255"
          value="{{email}}"
          placeholder="例如 patient@example.com"
          placeholder-class="input-placeholder"
          data-field="email"
          bindinput="onFieldInput"
        />
      </view>

      <view class="field-block">
        <text class="field-label">密码</text>
        <view class="password-control">
          <input
            class="password-input"
            type="text"
            password="{{!showPassword}}"
            maxlength="128"
            value="{{password}}"
            placeholder="请输入密码"
            placeholder-class="input-placeholder"
            data-field="password"
            bindinput="onFieldInput"
          />
          <text
            class="visibility-button"
            bindtap="togglePasswordVisibility"
          >{{showPassword ? '隐藏' : '显示'}}</text>
        </view>
        <text class="password-hint">
          8至128位，不能为纯数字或常见弱密码
        </text>
      </view>

      <view class="field-block">
        <text class="field-label">确认密码</text>
        <view class="password-control">
          <input
            class="password-input"
            type="text"
            password="{{!showConfirmPassword}}"
            maxlength="128"
            value="{{confirmPassword}}"
            placeholder="请再次输入密码"
            placeholder-class="input-placeholder"
            data-field="confirmPassword"
            bindinput="onFieldInput"
          />
          <text
            class="visibility-button"
            bindtap="toggleConfirmPasswordVisibility"
          >{{showConfirmPassword ? '隐藏' : '显示'}}</text>
        </view>
      </view>
    </view>

    <view class="consent-panel">
      <checkbox-group
        class="consent-checkbox-group"
        bindchange="onConsentChange"
      >
        <label class="consent-checkbox-label">
          <checkbox
            value="agreed"
            checked="{{consentAgreed}}"
            color="#3f7c78"
          />
        </label>
      </checkbox-group>
      <view class="consent-copy">
        <text>我已阅读并同意</text>
        <text class="consent-link" bindtap="showConsentSummary">
          《知情同意说明摘要》
        </text>
      </view>
    </view>

    <button
      class="register-button"
      form-type="submit"
      loading="{{submitting}}"
      disabled="{{submitting}}"
    >
      {{submitting ? '正在创建账号...' : '创建账号并登录'}}
    </button>
  </form>

  <text class="back-login" bindtap="goBackToLogin">
    已有账号，返回登录
  </text>

  <text class="medical-tip">
    本平台仅用于辅助筛查，不替代专业医生诊断
  </text>
</view>
```

- [ ] **Step 4: 运行结构测试**

Run:

```powershell
node miniprogram/tests/register-view.test.js
git diff --check
```

Expected: 打印 `注册页面结构测试全部通过`；空白检查无输出。此时只能证明结构契约满足，不能宣称微信编译已经通过。

- [ ] **Step 5: 精确暂存并提交 WXML 与结构测试**

Run:

```powershell
git add miniprogram/pages/register/index.wxml miniprogram/tests/register-view.test.js
git diff --cached --name-only
git commit -m "feat(miniprogram): build registration form structure"
```

Expected: 暂存清单只有两个路径，并创建独立提交。

### Task 7: 先扩展样式契约测试，再实现完整 WXSS

**Files:**
- Modify: `miniprogram/tests/register-view.test.js`
- Modify: `miniprogram/pages/register/index.wxss`

- [ ] **Step 1: 先扩展静态测试，要求关键样式存在**

In `miniprogram/tests/register-view.test.js`, insert immediately after reading `wxml`:

```js
const wxss = fs.readFileSync(
  path.join(registerDirectory, 'index.wxss'),
  'utf8'
)
```

Insert immediately before the final `console.log`:

```js
const requiredWxssSnippets = [
  '.register-page',
  'min-height: 100vh',
  '.register-card',
  '.choice-card--active',
  '.gender-option--active',
  '.password-control',
  '.consent-panel',
  '.register-button[disabled]',
  'env(safe-area-inset-bottom)',
  '#17324d',
  '#3f7c78'
]

for (const snippet of requiredWxssSnippets) {
  assert.equal(
    wxss.includes(snippet),
    true,
    `WXSS 缺少：${snippet}`
  )
}

assert.equal(
  /position\s*:\s*fixed/.test(wxss),
  false,
  '注册表单不能用 fixed 定位锁死页面滚动'
)
```

- [ ] **Step 2: 运行测试并确认旧占位样式导致失败**

Run:

```powershell
node miniprogram/tests/register-view.test.js
```

Expected: FAIL，提示缺少 `.choice-card--active`、`.gender-option--active` 或其他关键样式。

- [ ] **Step 3: 替换为完整分区单页 WXSS**

Replace `miniprogram/pages/register/index.wxss` with:

```css
page {
  min-height: 100%;
  background: #f4f7fa;
}

.register-page {
  min-height: 100vh;
  box-sizing: border-box;
  padding: 72rpx 32rpx calc(60rpx + env(safe-area-inset-bottom));
}

.register-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 18rpx 16rpx 6rpx;
}

.register-title {
  color: #17324d;
  font-size: 44rpx;
  font-weight: 700;
  line-height: 1.4;
}

.register-subtitle {
  margin-top: 16rpx;
  color: #64748b;
  font-size: 27rpx;
  line-height: 1.6;
  text-align: center;
}

.register-card {
  margin-top: 36rpx;
  padding: 40rpx 32rpx;
  border-radius: 28rpx;
  background: #ffffff;
  box-shadow: 0 16rpx 44rpx rgba(23, 50, 77, 0.09);
}

.section-title {
  display: block;
  color: #17324d;
  font-size: 32rpx;
  font-weight: 700;
}

.section-description {
  display: block;
  margin-top: 10rpx;
  color: #718096;
  font-size: 24rpx;
  line-height: 1.6;
}

.field-block {
  margin-top: 32rpx;
}

.field-label {
  display: block;
  margin-bottom: 14rpx;
  color: #17324d;
  font-size: 27rpx;
  font-weight: 600;
}

.field-help {
  display: block;
  margin: -4rpx 0 16rpx;
  color: #8795a3;
  font-size: 22rpx;
  line-height: 1.5;
}

.field-input,
.password-control {
  box-sizing: border-box;
  border: 2rpx solid #dce5ec;
  border-radius: 18rpx;
  background: #f7f9fb;
}

.field-input {
  width: 100%;
  height: 88rpx;
  padding: 0 24rpx;
  color: #17324d;
  font-size: 28rpx;
}

.input-placeholder {
  color: #9aa8b5;
}

.choice-grid {
  display: flex;
  justify-content: space-between;
}

.choice-card {
  width: 48%;
  box-sizing: border-box;
  padding: 24rpx 20rpx;
  border: 2rpx solid #dce5ec;
  border-radius: 20rpx;
  background: #f7f9fb;
}

.choice-card--active {
  border-color: #3f7c78;
  background: #edf8f5;
  box-shadow: 0 8rpx 20rpx rgba(63, 124, 120, 0.12);
}

.choice-title,
.choice-description {
  display: block;
}

.choice-title {
  color: #17324d;
  font-size: 27rpx;
  font-weight: 600;
}

.choice-description {
  margin-top: 8rpx;
  color: #718096;
  font-size: 21rpx;
}

.choice-card--active .choice-title {
  color: #2f6f6b;
}

.gender-grid {
  display: flex;
  flex-wrap: wrap;
  margin: -8rpx;
}

.gender-option {
  min-width: 134rpx;
  box-sizing: border-box;
  margin: 8rpx;
  padding: 18rpx 20rpx;
  border: 2rpx solid #dce5ec;
  border-radius: 18rpx;
  color: #526575;
  background: #f7f9fb;
  font-size: 25rpx;
  text-align: center;
}

.gender-option--active {
  border-color: #3f7c78;
  color: #2f6f6b;
  background: #edf8f5;
  font-weight: 600;
}

.password-control {
  height: 88rpx;
  display: flex;
  align-items: center;
}

.password-input {
  flex: 1;
  min-width: 0;
  height: 84rpx;
  padding-left: 24rpx;
  color: #17324d;
  background: transparent;
  font-size: 28rpx;
}

.visibility-button {
  flex-shrink: 0;
  padding: 22rpx 24rpx;
  color: #3f7c78;
  font-size: 24rpx;
  font-weight: 600;
}

.password-hint {
  display: block;
  margin-top: 12rpx;
  color: #8795a3;
  font-size: 22rpx;
  line-height: 1.5;
}

.consent-panel {
  margin-top: 30rpx;
  padding: 28rpx;
  display: flex;
  align-items: flex-start;
  border-radius: 22rpx;
  background: #eaf4f3;
}

.consent-checkbox-group,
.consent-checkbox-label {
  flex-shrink: 0;
}

.consent-copy {
  flex: 1;
  padding-top: 2rpx;
  color: #526575;
  font-size: 24rpx;
  line-height: 1.7;
}

.consent-link {
  color: #2f6f6b;
  font-weight: 600;
}

.register-button {
  margin-top: 34rpx;
  height: 92rpx;
  line-height: 92rpx;
  border-radius: 18rpx;
  color: #ffffff;
  background: #17324d;
  font-size: 31rpx;
  font-weight: 600;
}

.register-button::after {
  border: none;
}

.register-button[disabled] {
  color: rgba(255, 255, 255, 0.82);
  background: #607487;
}

.back-login {
  display: block;
  margin-top: 30rpx;
  color: #3f7c78;
  font-size: 25rpx;
  text-align: center;
}

.medical-tip {
  display: block;
  margin-top: 42rpx;
  color: #8795a3;
  font-size: 22rpx;
  line-height: 1.6;
  text-align: center;
}
```

- [ ] **Step 4: 运行完整视图契约测试**

Run:

```powershell
node miniprogram/tests/register-view.test.js
git diff --check
```

Expected: 打印 `注册页面结构测试全部通过`；空白检查无输出。静态测试不代替微信开发者工具的实际渲染检查。

- [ ] **Step 5: 精确暂存并提交样式**

Run:

```powershell
git add miniprogram/pages/register/index.wxss miniprogram/tests/register-view.test.js
git diff --cached --name-only
git commit -m "style(miniprogram): finish registration page layout"
```

Expected: 暂存清单只有两个路径，并创建独立提交。

### Task 8: 执行完整自动化回归和源码检查

**Files:**
- Verify only: `miniprogram/tests/*.test.js`
- Verify only: JavaScript files touched by this feature

- [ ] **Step 1: 逐个运行全部注册测试，任何一个失败立即停止**

Run:

```powershell
Get-ChildItem -LiteralPath 'miniprogram\tests' -Filter '*.test.js' | Sort-Object Name | ForEach-Object {
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: 依次看到校验、错误处理、页面控制、请求数据转换和页面结构的“全部通过”信息，最终退出码为 0。

- [ ] **Step 2: 对全部本次相关 JavaScript 做语法检查**

Run each command separately so A can identify the exact failing file:

```powershell
node --check miniprogram/app.js
node --check miniprogram/utils/request.js
node --check miniprogram/utils/register-validation.js
node --check miniprogram/utils/register-payload.js
node --check miniprogram/utils/register-error.js
node --check miniprogram/pages/login/index.js
node --check miniprogram/pages/register/index.js
node --check miniprogram/pages/home/index.js
node --check miniprogram/tests/register-validation.test.js
node --check miniprogram/tests/register-payload.test.js
node --check miniprogram/tests/register-error.test.js
node --check miniprogram/tests/register-page.test.js
node --check miniprogram/tests/register-view.test.js
```

Expected: 每条命令都无输出且退出码为 0。

- [ ] **Step 3: 检查空白错误、剩余改动与提交历史**

Run:

```powershell
git diff --check
git status --short
git log -10 --oneline
```

Expected: `git diff --check` 无输出；状态中不应再出现尚未提交的小程序注册实现文件。计划文档可以保持未提交，直到计划确认与执行记录整理完成。

### Task 9: 在微信开发者工具中逐项编译和手工验证

**Files:**
- Verify only: `C:\Users\Lenovo\Desktop\源码\miniprogram`

本任务由项目成员 A 在微信开发者工具操作。执行者每次只发下面一个 Step，等待 A 报告“看到的实际结果”后才继续，不要一次要求 A 做完整清单。

- [ ] **Step 1: 打开正确的小程序项目**

1. 启动“微信开发者工具”。
2. 如果首页已经有本项目，点击它；否则点击“导入项目”。
3. “目录”选择：`C:\Users\Lenovo\Desktop\源码\miniprogram`。
4. 确认 AppID 显示为项目配置中的 `wx5fc79e35c64730d9`。
5. 点击“导入”或“打开”。

Expected: 模拟器出现“ADHD智慧辅助诊断平台”的患者登录页。若工具提示登录、AppID 权限或基础库问题，原样记录提示，不要随意更换 AppID。

- [ ] **Step 2: 打开本地开发网络设置**

1. 点击右上角“详情”。
2. 打开“本地设置”。
3. 仅在开发阶段勾选“不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书”。
4. 返回编辑器。

Expected: 开发者工具允许请求 `http://127.0.0.1:8000`。这一设置只用于本地联调，真机或上线仍必须改成已备案 HTTPS 域名。

- [ ] **Step 3: 编译并检查问题面板**

1. 点击顶部“编译”。
2. 等待模拟器停止刷新。
3. 打开底部“调试器”的 Console，确认没有红色编译错误。
4. 打开编辑器的“问题”面板，查看错误数量。

Expected: 问题面板错误数为 0；Console 没有 WXML、WXSS 或 JavaScript 语法错误。警告需逐条记录，不能直接当成错误为 0。

- [ ] **Step 4: 从登录页进入注册页**

1. 在登录卡片下方点击“首次使用请先注册患者账号”。
2. 不填写登录账号或密码。

Expected: 进入标题为“患者注册”的页面；顶部看到“创建患者账号”，并依次看到“患者信息”“账号安全”两个白色卡片。

- [ ] **Step 5: 验证页面能完整纵向滚动**

1. 在模拟器中从页面中部向上拖动。
2. 一直滚到最底部。
3. 再向下拖动回到顶部。

Expected: 能看到知情同意、主按钮、“已有账号，返回登录”和免责声明；页面没有被固定定位锁住，文字没有被按钮遮挡。

- [ ] **Step 6: 验证患者类型与性别选择状态**

1. 点击“成人患者”，确认成人卡片出现青绿色选中状态。
2. 点击“儿童患者”，确认选中状态从成人切换到儿童。
3. 依次点击“男”“女”“其他”“不愿透露”。

Expected: 患者类型始终只有一个选中；性别始终只有最后点击的一项选中；年龄变化不会自动改患者类型。

- [ ] **Step 7: 验证输入键盘与密码显示切换**

1. 点击“年龄”输入框，观察模拟器键盘类型。
2. 在密码框输入一段仅用于本地测试的临时密码，不要使用真实账号密码。
3. 点击第一个“显示”，确认只显示第一个密码框。
4. 点击确认密码旁的“显示”，确认第二个密码框独立切换。
5. 再分别点击“隐藏”。

Expected: 年龄使用数字键盘；两个密码框互不影响；默认都隐藏。

- [ ] **Step 8: 验证知情同意摘要与默认未勾选状态**

1. 首次进入页面时确认复选框为空。
2. 点击《知情同意说明摘要》。
3. 阅读弹窗并点击“我知道了”。
4. 点击复选框使其选中，再点击一次取消。

Expected: 弹窗提到数据用途、辅助筛查、不替代专业医生诊断和正式文本待审核；打开弹窗不会自动勾选；复选框可独立切换。

- [ ] **Step 9: 验证本地校验按第一条错误阻止请求**

每次点击“创建账号并登录”只修正当前提示的一个字段，然后再次点击，按以下顺序观察：

1. 全空：提示“请输入患者姓名”。
2. 姓名只填一个字：提示“患者姓名至少需要2个字符”。
3. 邮箱格式错误：提示“请输入正确的邮箱地址”。
4. 密码少于 8 位：提示“密码长度不能少于8位”。
5. 两次密码不同：提示“两次输入的密码不一致”。
6. 未选择患者类型：提示“请选择患者类型”。
7. 年龄为 0、小数或超过 120：提示年龄必须是 1 至 120 之间的整数。
8. 其他字段均有效但未勾选同意：提示“请阅读并同意知情同意说明”。

Expected: 每次只出现第一条相关中文提示；Network 面板没有发出 `/auth/register` 请求。

- [ ] **Step 10: 在后端未启动时验证错误和表单保留**

1. 确认本机没有启动 `127.0.0.1:8000` 后端。
2. 填写一组合法测试数据并勾选同意。
3. 点击一次“创建账号并登录”。
4. 等待按钮停止加载。

Expected: 显示“无法连接服务器，请检查后端是否启动”或在 10 秒后显示超时提示；姓名、邮箱、类型、年龄、性别和两个密码仍保留；页面不跳转；按钮恢复可用。

- [ ] **Step 11: 验证重复点击保护**

1. 再次提交合法数据。
2. 在按钮仍显示“正在创建账号...”时快速连续点击两次。
3. 打开调试器 Network 面板，按 `/auth/register` 过滤。

Expected: 同一轮提交最多只有 1 个注册请求；按钮加载期间不可再次触发。失败后按钮才恢复。

- [ ] **Step 12: 验证返回登录与敏感信息边界**

1. 点击“已有账号，返回登录”。
2. 确认回到患者登录页。
3. 查看 Console，不应看到输入的明文密码、完整注册请求或 token。
4. 后端尚未成功响应时，在 Console 仅执行布尔检查：

```js
Boolean(wx.getStorageSync('access_token'))
```

Expected: 返回登录正常；Console 没有敏感值；后端未成功响应时布尔结果应为 `false`（除非该开发者工具此前已有登录态，此时先说明现状，不直接清除用户数据）。

### Task 10: 后端可用后完成真实联调（不可提前宣称完成）

**Files:**
- Verify only: `backend/app/api/routes/auth.py`
- Verify only: `backend/app/schemas/auth.py`
- Verify only: `backend/app/core/password_policy.py`
- Verify only: `miniprogram/utils/request.js`

Precondition: 后端依赖、数据库和环境变量由项目当前负责人确认可用。仓库根目录已有 `requirements.txt`，项目 `.venv` 已验证依赖完整；启动时优先使用该虚拟环境，不要混用缺少依赖的系统 Python。若启动仍缺依赖，应记录错误并单独修复环境，不把它混入患者注册前端提交。

- [ ] **Step 1: 在新的 PowerShell 窗口启动后端**

From repository root, using the already-prepared Python environment:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --reload
```

Expected: 控制台显示服务监听 `http://127.0.0.1:8000`。如果出现缺包、数据库或环境变量错误，停止联调并原样记录；此时前端实现可标记“自动化与开发者工具离线场景通过，真实接口被后端环境阻塞”，不能标记端到端完成。

- [ ] **Step 2: 验证服务健康后再打开注册页**

In another PowerShell window:

```powershell
Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:8000/api/v1/health'
```

Expected: 返回健康响应且无连接错误。随后回到微信开发者工具点击“编译”。

- [ ] **Step 3: 注册一名成人测试患者**

Use a unique non-production email and temporary test password. Fill:

```text
患者姓名：成人测试患者
患者类型：成人患者
年龄：20
性别：女
邮箱：使用本轮唯一测试邮箱
密码：使用满足策略的临时测试密码
确认密码：与上面一致
知情同意：勾选
```

Expected: Network 中 `POST /api/v1/auth/register` 返回 HTTP 201；页面显示“注册成功”并进入患者首页；首页问候显示“成人测试患者”。不要在聊天、截图或 Console 中暴露密码或 token。

- [ ] **Step 4: 只检查登录态是否存在，不打印 token**

In WeChat Developer Tools Console:

```js
Boolean(wx.getStorageSync('access_token'))
wx.getStorageSync('current_user').full_name
```

Expected: 第一条为 `true`；第二条为 `成人测试患者`。

- [ ] **Step 5: 注册一名儿童测试患者**

Return to the login/register flow and use another unique email:

```text
患者姓名：儿童测试患者
患者类型：儿童患者
年龄：10
性别：不愿透露（也可保持未选择以验证 null）
邮箱：另一个本轮唯一测试邮箱
密码：新的合规临时测试密码
确认密码：与上面一致
知情同意：勾选
```

Expected: HTTP 201，自动进入首页；Network 请求体中的 `patient_profile.patient_type` 为 `child`、`age` 为数字 `10`，未选性别时为 `null`。检查请求体时不要复制或外发其中的密码。

- [ ] **Step 6: 验证重复邮箱**

1. 返回注册页。
2. 使用 Step 3 已成功注册的邮箱和其他合法字段再次提交。

Expected: 不离开注册页；提示“该邮箱已经注册，请直接登录”；表单内容保留；按钮恢复可用。

- [ ] **Step 7: 验证后端密码策略错误与离线恢复**

1. 用后端会拒绝的密码测试一次，确认展示安全提示而非内部对象。
2. 停止后端窗口（按 `Ctrl+C`）。
3. 再提交一组合法数据。

Expected: 密码策略提示可读；服务停止后显示连接失败或超时提示，表单保留，不写入新的登录状态。

- [ ] **Step 8: 最终状态记录**

Record all four results separately:

```text
成人注册：通过 / 未通过（原因）
儿童注册：通过 / 未通过（原因）
重复邮箱：通过 / 未通过（原因）
后端离线：通过 / 未通过（原因）
```

只有四项均有真实证据时，才把真实注册联调标为完成。

### Task 11: 最终验证、计划记录与干净交接

**Files:**
- Modify only if needed for execution tracking: `docs/superpowers/plans/2026-08-20-miniprogram-patient-registration.md`

- [ ] **Step 1: 再跑一次完整自动化验证（必须使用新鲜输出）**

Run:

```powershell
Get-ChildItem -LiteralPath 'miniprogram\tests' -Filter '*.test.js' | Sort-Object Name | ForEach-Object {
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
git diff --check
git status --short
```

Expected: 所有测试通过、空白检查无输出、状态清单中没有意外删除或无关暂存文件。

- [ ] **Step 2: 对照完成标准逐项报告，不夸大状态**

Report exactly:

- Node 自动化测试：通过/未通过，并附实际命令输出摘要；
- JavaScript 语法检查：通过/未通过；
- 微信开发者工具问题面板：由 A 验证为 0/尚未验证；
- 成人与儿童页面流程：通过/未通过；
- 后端真实联调：通过/被后端环境阻塞/尚未执行；
- 未提交文件：完整列出，确认未执行 reset、checkout 或删除。

- [ ] **Step 3: 计划执行完成后再提交计划记录**

Run only after A has approved the plan and the checked boxes accurately reflect execution:

```powershell
git add docs/superpowers/plans/2026-08-20-miniprogram-patient-registration.md
git diff --cached --name-only
git commit -m "docs: add patient registration implementation plan"
```

Expected: 暂存清单只有本计划文件，并创建独立文档提交。

## 计划自审结果

- **规格覆盖：** 已映射姓名、患者类型、年龄、可选性别、邮箱、两次密码、独立显隐、弱密码、知情同意、载荷转换、重复提交、错误翻译、表单保留、token/用户存储、全局状态、首页跳转、返回登录、滚动、敏感信息边界、成人/儿童及后端离线场景。
- **范围控制：** 未加入邮箱验证码、找回密码、注销、监护人资料、手机号、用户名、自动年龄推导或虚假占位入口。
- **占位符扫描：** 已检查所有禁用占位语句，未发现不可执行、待补写或含糊的实现步骤。
- **接口一致性：** 页面字段统一为 `fullName/email/patientType/age/gender/password/confirmPassword/consentAgreed/showPassword/showConfirmPassword/submitting`；后端载荷统一为 `email/password/full_name/role/consent_agreed/patient_profile`；页面检查 `access_token` 和 `user` 后才保存状态。
- **TDD 顺序：** 每个新增纯模块、页面控制逻辑和视图契约均先运行失败测试，再写最小实现，再回归验证；WXML/WXSS 另有微信开发者工具验证门槛。
- **已有改动保护：** Task 1 先验证并精确提交路由、登录入口和注册占位文件；后续均使用精确路径暂存，没有 reset、checkout 或删除步骤。

## 执行记录（2026-08-21）

- **Task 1—8：已完成。** 注册入口、校验、载荷转换、错误映射、页面控制逻辑、WXML、WXSS 和自动化回归测试均已按“先失败、再实现、再验证”的顺序完成并分别提交。
- **Task 9：已完成主要人工验收。** A 已在微信开发者工具确认页面滚动、成人/儿童与性别选择、密码独立显隐、知情同意、校验提示、离线恢复、返回登录和按钮居中。人工测试曾发现快速重复点击产生两次请求，随后已新增确定性回归测试和 800 毫秒提交冷却保护；修复后的自动化回归通过，未再次要求 A 重复人工操作。
- **Task 10：已完成。** 使用项目 `.venv` 和仅供本地开发的 SQLite 配置启动后端；健康检查通过。成人与儿童真实注册、登录态写入、重复邮箱提示、密码策略错误、离线错误和本地数据库记录均已取得证据。`backend/.env` 与 `backend/app.db` 均由 `.gitignore` 排除，未提交本地配置或测试数据。
- **Task 11：已完成。** 最终提交前已重新运行 5 个 Node 测试文件、13 个相关 JavaScript 文件语法检查、71 个后端 Python 文件语法解析、后端健康检查、SQLite 只读记录检查、Git 空白检查和代码审查。仓库未配置后端 pytest 测试套件，虚拟环境也未安装 pytest，因此未把 `pytest` 作为本功能的完成证据。计划文档作为独立提交保存。
- **微信开发者工具证据：** A 报告问题面板为 0；成人首页显示“成人测试患者”，儿童首页显示“儿童测试患者”；登录 token 仅以布尔值检查，没有在聊天中输出实际 token。
- **敏感信息边界：** 真实联调使用的账号口令和 token 不写入计划、提交信息或测试夹具；自动化测试只使用固定的非生产示例密码。代码没有记录注册请求体。SQLite 中的本地测试账户仅用于联调，不纳入 Git。
