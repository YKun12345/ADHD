# 小程序医生工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有患者小程序中加入安全的研究者登录分流、医生工作台和移动患者报告。

**Architecture:** 新增通用角色会话模块和研究者页面守卫，登录页根据所选角色请求并分流。医生首页和患者详情直接使用现有 `/doctor` 与 `/care/doctor` API，不缓存患者报告；后端角色和患者归属检查保持最终安全边界。

**Tech Stack:** 微信小程序 WXML/WXSS/CommonJS、现有请求层、Node.js 内置测试运行器、FastAPI 既有 API。

---

### Task 1: 角色会话与登录分流

**Files:**
- Create: `miniprogram/utils/role-session.js`
- Create: `miniprogram/utils/doctor-page.js`
- Create: `miniprogram/tests/role-session.test.js`
- Modify: `miniprogram/app.js`
- Modify: `miniprogram/pages/login/index.js`
- Modify: `miniprogram/pages/login/index.wxml`
- Modify: `miniprogram/pages/login/index.wxss`
- Modify: `miniprogram/tests/app-session.test.js`
- Modify: `miniprogram/tests/login-page.test.js`

- [x] 编写失败测试，断言患者/研究者会话验证、目标页映射、非法角色拒绝和研究者页面守卫。
- [x] 运行 `node --test miniprogram/tests/role-session.test.js`，确认模块缺失导致失败。
- [x] 实现 `hasValidRoleSession`、`hasValidAnySession`、`getRoleDestination`、`ensureResearcherSession` 和 `registerDoctorPage`。
- [x] 编写登录失败测试，断言角色选择进入请求体，响应角色不匹配不保存，研究者成功后进入 `/pages/doctor-home/index`。
- [x] 修改登录页增加两个角色选项，并复用现有会话原子替换和患者数据清理逻辑。
- [x] 修改 `app.js` 保留合法研究者会话，运行角色、登录和启动测试至通过。

### Task 2: 医生工作台

**Files:**
- Create: `miniprogram/pages/doctor-home/index.js`
- Create: `miniprogram/pages/doctor-home/index.json`
- Create: `miniprogram/pages/doctor-home/index.wxml`
- Create: `miniprogram/pages/doctor-home/index.wxss`
- Create: `miniprogram/tests/doctor-home-page.test.js`
- Modify: `miniprogram/app.json`

- [x] 编写失败控制器测试，模拟 `dashboard_stats`、`my_patients` 与 `bind_patient`，断言仅研究者守卫允许加载。
- [x] 编写失败视图断言，要求统计卡、绑定表单、患者列表、空状态、退出入口和 88rpx 触控区域。
- [x] 实现页面并确保绑定邮箱仅由点击触发、请求期间防重复、成功后刷新列表。
- [x] 把页面注册到 `app.json`，运行工作台测试至通过。

### Task 3: 医生患者详情与消息

**Files:**
- Create: `miniprogram/pages/doctor-patient/index.js`
- Create: `miniprogram/pages/doctor-patient/index.json`
- Create: `miniprogram/pages/doctor-patient/index.wxml`
- Create: `miniprogram/pages/doctor-patient/index.wxss`
- Create: `miniprogram/tests/doctor-patient-page.test.js`
- Create: `miniprogram/tests/doctor-views.test.js`
- Modify: `miniprogram/app.json`

- [x] 编写失败测试，断言非法 patient_id 不请求，合法 ID 并行获取报告和消息，发送内容去空白并限制 2000 字。
- [x] 编写失败视图测试，要求量表、认知、追踪、建议、影像/模型、消息、免责声明和不缓存报告契约。
- [x] 实现详情页，仅把报告保存在 `data`，不调用 `wx.setStorageSync`。
- [x] 注册页面并运行医生页面测试至通过。

### Task 4: 完整回归与本地保留

**Files:**
- Verify: `miniprogram/**/*.js`
- Verify: `miniprogram/**/*.json`
- Verify: Git working tree

- [x] 运行全部 `miniprogram/tests/*.test.js`，要求零失败。
- [x] 对全部小程序 JavaScript 运行 `node --check`。
- [x] 解析全部小程序 JSON 文件，要求零异常。
- [x] 运行 `git diff --check` 并确认无后端业务文件、数据库或密钥进入新增改动。
- [x] 保持本地分支，无 commit、merge 或 push。
