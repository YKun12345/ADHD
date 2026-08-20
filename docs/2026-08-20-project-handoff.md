# ADHD 智慧辅助诊断平台当前工作交接

日期：2026-08-20

## 1. 当前人员与工作原则

- 当前操作者是 A，B 暂时不能工作。
- A 继续负责整个 `miniprogram/`。
- 不等待 B 才开发前端，但所有真实接口仍按现有 FastAPI 契约设计。
- 不把后端已有代码误写为“已经验证”；后端本轮尚未启动并完成接口联调。
- 用户需要非常具体、逐步、适合微信开发者工具操作的指导。
- 用户要求实现必须合理、可维护，不接受只有表面效果的占位实现。
- 保留当前工作区的全部未提交文件，不得执行 `git reset --hard`、`git checkout --` 或删除现有改动。

## 2. 已确认的项目目标

A 最终需要交付可以扫码运行，并完成以下闭环的小程序：

```text
注册或登录
→ 患者首页
→ 行为量表
→ 认知测试
→ 14 天追踪
→ 综合报告
```

后续还包括 AI 助手、临床路径、科普、真机测试、演示视频和答辩 PPT。

## 3. 已完成并验证的工作

### Git

- 项目根目录已经是 Git 仓库，分支为 `main`。
- 已完成项目基线提交：`43a696e chore: establish project baseline`。
- 已建立 `.gitignore`，排除虚拟环境、密钥、本地数据库、依赖、模型文件、微信开发者工具私有配置和 `.superpowers/` 草图目录。
- 尚未建立私有远程仓库，尚未 push。

### 小程序基础

- 登录页是启动页。
- 已创建并美化登录页。
- 已创建并美化患者首页。
- 患者首页目前使用模拟数据，业务入口仍提示“功能开发中”。
- 已创建 `utils/request.js`，基础地址为 `http://127.0.0.1:8000/api/v1`。
- 请求封装支持 JSON、Bearer token、10 秒超时、HTTP 错误、401 清除登录状态和后端离线提示。
- `127.0.0.1` 仅适合开发者工具；真机联调时必须换成电脑局域网 IP 或 HTTPS 地址。

### 登录

- 登录页包含账号、密码、按钮和前端基础校验。
- 登录代码会调用 `POST /auth/login`，保存 `access_token` 和 `current_user`，然后进入 `/pages/home/index`。
- 登录页可以跳转 `/pages/register/index`，用户已手工验证跳转通过。
- 真实后端登录尚未验证，所以登录状态是“前端代码已完成、接口待联调”。

### 注册前置工作

- `app.json` 已加入 `pages/register/index`。
- 已创建标准目录 `miniprogram/pages/register/index.*`。
- 注册页目前仍是占位页，`index.js` 只有 `Page({})`，不能算注册功能完成。
- 已创建 `utils/register-validation.js`。
- 已创建 `tests/register-validation.test.js`。
- 已执行：

```powershell
node miniprogram/tests/register-validation.test.js
```

- 当前输出：`注册表单校验测试全部通过`。
- `app.js`、`request.js`、注册校验、登录页、首页和注册占位 JS 均通过 `node --check` 语法检查。

### 注册设计

- 用户选择并确认“B：分区单页”布局。
- 页面分为“患者信息”和“账号安全”两个卡片。
- 成人和儿童使用同一注册页面。
- 当前版本不增加儿童监护人字段。
- 知情同意使用可点击的弹窗摘要，正式文本需由指导老师或相关专业人员审核。
- 患者类型由用户主动选择，不根据年龄自动推导。
- 注册成功后应保存 token 和用户资料并自动进入患者首页。

正式设计文件：

- `docs/superpowers/specs/2026-08-20-miniprogram-patient-registration-design.md`
- 设计提交：`6dcd263 docs: design patient registration flow`
- 状态修正提交：`ab7617f docs: clarify registration submit locking`

## 4. 当前未提交的小程序文件

交接前的 `git status --short` 为：

```text
 M miniprogram/app.json
 M miniprogram/pages/login/index.js
 M miniprogram/pages/login/index.wxml
?? miniprogram/pages/register/
?? miniprogram/tests/
?? miniprogram/utils/register-validation.js
```

这些文件是当前正在开发的真实文件，不是备份或副本。新对话必须保留并在后续按功能拆分提交。

## 5. 已发现但尚未修正的注册校验差异

当前基础测试虽然通过，但进一步核对后端后发现仍需测试驱动补齐：

- 姓名长度必须为 2～100；
- 密码最大长度为 128；
- 前端弱密码名单必须与 `backend/app/core/password_policy.py` 对齐；
- 需要覆盖非法患者类型；
- 需要覆盖空年龄、小数、非数字和超过 120；
- 需要分别验证合法成人和合法儿童数据。

必须先增加失败测试，看到正确失败后，再修改 `utils/register-validation.js`。

## 6. 下一阶段需要创建的文件

- `miniprogram/utils/register-payload.js`：把页面状态转换成后端注册数据；
- `miniprogram/tests/register-payload.test.js`：验证字段转换、邮箱小写、年龄整数、空性别为 `null`，并确保不发送确认密码；
- 注册业务错误映射模块及测试：把重复邮箱、422、网络失败和响应不完整转换为中文提示；
- 完整的 `pages/register/index.js`、`index.wxml` 和 `index.wxss`。

## 7. 后端注册契约

实际接口：

```text
POST /api/v1/auth/register
```

患者请求结构：

```js
{
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
```

响应必须包含：

```text
access_token
token_type
user
```

`confirmPassword`、密码显示状态和提交状态不能发送给后端。

## 8. 注册页完整功能要求

- 患者姓名；
- 成人或儿童患者类型，不设置默认值；
- 年龄，数字键盘，1～120 整数；
- 可选性别：男、女、其他、不愿透露；
- 邮箱；
- 密码和确认密码；
- 两个密码框分别显示或隐藏；
- 密码规则提示；
- 知情同意勾选和摘要弹窗；
- 加载状态和重复提交保护；
- 失败后保留表单；
- 重复邮箱、422、网络失败、超时和响应缺少 token 的中文提示；
- 注册成功后保存 `access_token`、`current_user`，更新全局登录状态并 `wx.reLaunch` 到患者首页；
- 已有账号返回登录；
- 页面可以正常纵向滚动；
- 不记录明文密码、token 或完整注册请求。

## 9. 新对话应从这里继续

第一步不是直接覆盖注册页面，而是根据已确认设计创建详细实施计划：

```text
docs/superpowers/plans/2026-08-20-miniprogram-patient-registration.md
```

实施顺序应为：

1. 保留并提交已经验证的注册路由和登录页入口；
2. 先扩展注册校验失败测试，再补齐校验实现；
3. 先写请求数据转换失败测试，再创建 `register-payload.js`；
4. 先写注册错误映射失败测试，再实现错误映射；
5. 先测试注册页面控制逻辑，再实现 `index.js`；
6. 实现并验证 WXML；
7. 实现并验证 WXSS；
8. 运行全部 Node 测试和 JavaScript 语法检查；
9. 在微信开发者工具中确认问题面板为 0，并逐项手工测试；
10. 后端可用后完成成人、儿童、重复邮箱和离线场景联调。

每个阶段应使用精确路径 `git add` 并单独提交，不要把无关文件混入提交。

## 10. 当前总体进度判断

- 项目与小程序基础框架：约 70%；
- 登录前端：约 75%，真实后端未验证；
- 患者首页外观：约 60%，业务入口未开发；
- 注册功能：约 30%，设计和基础校验完成；
- 量表、认知测试、追踪、报告：接近 0%；
- AI、科普、临床路径：接近 0%；
- 后端联调、部署、真机、视频和 PPT：接近 0%；
- 按 A 的全部最终交付物估算：约 15%～20%。

下一里程碑是完成“注册—登录—进入患者首页”的账号闭环，然后开始行为量表开发。
