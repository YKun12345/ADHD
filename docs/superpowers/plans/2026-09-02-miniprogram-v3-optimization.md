# 小程序整体优化 V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前原生微信小程序与 FastAPI 后端上完成账号隔离引导、医患消息与任务闭环、专业报告、认知减负、追踪扩展和医生移动摘要。

**Architecture:** 共享引导模块负责所有页面的一次性介绍；care API 作为消息与任务唯一事实源；患者报告 API 继续承载只读专业结果。页面控制器只做数据规范化、状态展示和安全跳转，不复制领域规则。

**Tech Stack:** 微信原生小程序 JavaScript/WXML/WXSS、Node `node:test`、FastAPI、Pydantic、SQLAlchemy、Pytest。

---

### Task 1: 账号隔离的引导状态与文案

**Files:**
- Create: `miniprogram/utils/guide-state.js`
- Create: `miniprogram/utils/page-guide-content.js`
- Test: `miniprogram/tests/guide-state.test.js`

- [ ] 先写失败测试，覆盖账号/角色/版本隔离、关闭自动介绍、恢复页面介绍和清除后重现。
- [ ] 运行 `node --test miniprogram/tests/guide-state.test.js`，确认因模块缺失失败。
- [ ] 实现纯函数状态键、存取、已读标记和恢复接口。
- [ ] 再运行测试并确认通过。

### Task 2: 登录总引导与页面气泡

**Files:**
- Create: `miniprogram/components/onboarding-guide/index.{js,json,wxml,wxss}`
- Modify: `miniprogram/components/ai-copilot/index.{js,json,wxml,wxss}`
- Modify: `miniprogram/pages/home/index.{js,json,wxml}`
- Modify: `miniprogram/pages/doctor-home/index.{js,json,wxml}`
- Modify: `miniprogram/pages/privacy-settings/index.{js,wxml}`
- Test: `miniprogram/tests/onboarding-guide.test.js`
- Test: `miniprogram/tests/ai-copilot-component.test.js`

- [ ] 写组件与设置行为失败测试，先确认红灯。
- [ ] 实现单屏总引导、300ms/6s 页面气泡、遮罩触摸拦截和设置操作。
- [ ] 运行相关组件、接线和隐私页测试直至通过。

### Task 3: 星仔小狐狸状态系统

**Files:**
- Modify: `miniprogram/components/ai-mascot/index.{js,wxml,wxss}`
- Test: `miniprogram/tests/ai-mascot.test.js`

- [ ] 写七状态、名称、无外框和减少动态效果的失败测试。
- [ ] 实现最小 WXML/WXSS 状态差异与动画媒体查询。
- [ ] 运行星仔与 AI 视觉契约测试。

### Task 4: 后端 care 协议闭环

**Files:**
- Modify: `backend/app/models/patient_task.py`
- Modify: `backend/app/schemas/care.py`
- Modify: `backend/app/api/routes/care.py`
- Modify: `backend/app/db/init_db.py`
- Test: `backend/tests/test_care.py`

- [ ] 写任务截止时间、派生过期、未读计数、已读更新和权限失败测试。
- [ ] 确认新测试按预期失败。
- [ ] 实现字段、兼容升级与 API；所有查询继续限定患者归属。
- [ ] 运行 `python -m pytest backend/tests/test_care.py -q`。

### Task 5: 患者消息与任务页面

**Files:**
- Create: `miniprogram/utils/patient-care.js`
- Create: `miniprogram/pages/patient-messages/index.{js,json,wxml,wxss}`
- Create: `miniprogram/pages/patient-tasks/index.{js,json,wxml,wxss}`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/utils/home-dashboard.js`
- Modify: `miniprogram/pages/home/index.{js,wxml,wxss}`
- Test: `miniprogram/tests/patient-care.test.js`
- Test: `miniprogram/tests/patient-care-pages.test.js`

- [ ] 写数据规范化、安全任务跳转、失败重试和未读角标测试并确认失败。
- [ ] 实现两个页面、首页入口与未读数量；首页不渲染正文。
- [ ] 运行患者 care、首页和受保护页面测试。

### Task 6: 医生任务创建与摘要

**Files:**
- Modify: `miniprogram/utils/doctor-data.js`
- Modify: `miniprogram/pages/doctor-home/index.{js,wxml,wxss}`
- Modify: `miniprogram/pages/doctor-patient/index.{js,wxml,wxss}`
- Test: `miniprogram/tests/doctor-data.test.js`
- Test: `miniprogram/tests/doctor-pages-controller.test.js`

- [ ] 写搜索/筛选、任务表单、截止时间和状态显示失败测试。
- [ ] 实现任务创建、任务/未读摘要和患者回复查看。
- [ ] 运行医生端数据、控制器和视图测试。

### Task 7: 专业评估结果

**Files:**
- Modify: `miniprogram/utils/report-data.js`
- Modify: `miniprogram/pages/report/index.{js,wxml,wxss}`
- Modify: `miniprogram/utils/doctor-data.js`
- Modify: `miniprogram/pages/doctor-patient/index.{wxml,wxss}`
- Test: `miniprogram/tests/report-data.test.js`
- Test: `miniprogram/tests/report-page.test.js`

- [ ] 写专业数据映射、默认折叠和免责声明失败测试。
- [ ] 实现患者完整折叠区与医生只读摘要，不增加上传/推理控件。
- [ ] 运行报告和医生视图测试。

### Task 8: 认知协议减负

**Files:**
- Modify: `miniprogram/utils/cognitive-config.js`
- Modify: `miniprogram/utils/digit-span-test.js`
- Modify: `miniprogram/utils/cognitive-results.js`
- Modify: `miniprogram/pages/cognitive-center/index.{js,wxml}`
- Modify: `miniprogram/pages/*/index.wxml`（七项认知说明）
- Test: `miniprogram/tests/cognitive-config.test.js`
- Test: `miniprogram/tests/digit-span-test.test.js`

- [ ] 写目标题量、约 24 节点、自适应停止、三组合和协议元数据失败测试。
- [ ] 修改配置和生成逻辑，保持量表题量不变。
- [ ] 运行全部认知测试。

### Task 9: 快速与详细每日追踪

**Files:**
- Modify: `backend/app/models/tracking_log.py`
- Modify: `backend/app/schemas/tracking.py`
- Modify: `backend/app/api/routes/patient.py`
- Modify: `backend/app/db/init_db.py`
- Modify: `miniprogram/utils/tracking-data.js`
- Modify: `miniprogram/pages/tracking/index.{js,wxml,wxss}`
- Test: `backend/tests/test_tracking_extended.py`
- Test: `miniprogram/tests/tracking-data.test.js`

- [ ] 写详细字段校验、序列化、本地恢复和默认折叠失败测试。
- [ ] 实现数据库/API/页面字段，快速字段保持默认可见。
- [ ] 运行后端扩展追踪与小程序追踪测试。

### Task 10: 全量验证与需求审计

**Files:**
- Modify: `docs/evidence/manual-acceptance.md`

- [ ] 运行 `node --test miniprogram/tests/*.test.js`。
- [ ] 运行 `.\.venv\Scripts\python.exe -m pytest backend/tests -q`。
- [ ] 运行 Python 编译、Ruff 和仓库测试。
- [ ] 检查 `git diff --check`、`git status --short` 和需求覆盖；记录真机验收仍需人工执行。
- [ ] 不执行 commit、merge 或 push。
