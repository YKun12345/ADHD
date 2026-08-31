# 微信小程序 ASRS 成人行为量表设计

日期：2026-08-21

## 1. 范围

本子项目对应 A 端 D4：把现有 Web 版 ASRS 18 题迁移为原生微信小程序页面，支持单题作答、前后切换、进度、草稿恢复、提交和结果展示。

本阶段不实现 B 负责的量表服务端算分，不修改 `backend/`。小程序只按既有契约调用 `POST /patient/submit_scale`；接口不可用时保留草稿并提示稍后重试。

SNAP-IV 26 题属于 D5，不混入 D4。儿童账户看到明确的量表适配说明，不能误填成人 ASRS。

## 2. 方案比较

### 方案 A：18 题全部纵向展开

实现简单，但手机页面过长，容易漏题，也不符合 PDF 指定的单题移动体验。

### 方案 B：使用 `swiper` 自动切题

视觉流畅，但手势和选项点击容易冲突，草稿恢复和测试更复杂。

### 方案 C：单题卡片 + 明确的上一题/下一题按钮（采用）

一次只显示一题，点击选项后由用户明确进入下一题。状态可预测、便于返回修改，也容易用纯逻辑和页面控制器测试覆盖。

## 3. 文件边界

- `miniprogram/utils/asrs-scale.js`：18 题配置、答案清洗、进度、完整性校验和请求载荷；不访问 `wx`。
- `miniprogram/pages/scale/index.js`：读取患者类型、管理草稿、控制题目切换、调用请求和显示结果。
- `miniprogram/pages/scale/index.wxml`：成人说明、单题卡、选项、导航、提交状态和结果。
- `miniprogram/pages/scale/index.wxss`：移动端单题布局和状态样式。
- `miniprogram/tests/asrs-scale.test.js`：纯逻辑测试。
- `miniprogram/tests/scale-page.test.js`：页面控制器测试。
- `miniprogram/tests/scale-view.test.js`：WXML/WXSS 静态契约测试。

## 4. 状态与数据流

页面状态：

```text
patientSupported
currentIndex
answers
currentQuestion
selectedValue
progressPercent
submitting
result
```

进入页面时读取 `current_user.patient_profile.patient_type`。只有 `adult` 启用 ASRS；其他类型显示适配说明和返回首页按钮。

成人流程：

```text
读取草稿 → 清洗连续有效答案 → 定位首个未答题
→ 选择 0—4 → 保存草稿 → 上一题/下一题
→ 第 18 题完整校验 → 构造 ASRS 请求 → 调现有接口
→ 成功清草稿并展示后端结果 / 失败保留草稿并恢复按钮
```

草稿键固定为 `scale_draft_asrs`，只保存 0—4 的数字答案，不保存姓名、邮箱、token 或后端响应。

## 5. 接口契约

请求：

```js
{
  url: '/patient/submit_scale',
  method: 'POST',
  data: {
    scale_type: 'ASRS',
    respondent_type: 'self',
    answers: [0, 1, 2]
  }
}
```

只有 18 个答案全部是 0—4 整数时才能提交。页面不在本地计算或声称医学风险等级。

成功响应只展示后端返回的 `total_score`、`risk_level`、`summary` 和 `recommendations`；响应结构不完整时提示“量表结果不完整，请稍后重试”，保留草稿。

## 6. 首页入口

完成 D4 后，在 `app.json` 注册 `/pages/scale/index`。成人患者首页的行为量表任务和快捷入口启用；儿童患者仍显示“儿童量表将在 D5 开放”。认知测试、追踪和报告继续保持明确不可用。

## 7. 错误与安全

- 未选择答案时不能进入下一题；
- 草稿中的非法值从首个非法位置截断；
- 连续点击提交只发送一次请求；
- 请求失败保留全部答案和当前题；
- 不记录答案请求体、token 或患者资料；
- 结果页保留“仅用于辅助筛查，不替代专业医生诊断”。

## 8. 测试与验收

- 纯逻辑：题数、选项、草稿清洗、不可变更新、进度、完整性和 payload；
- 页面：成人/儿童分支、草稿恢复、未答拦截、前后题、成功、失败和重复提交；
- 视图：单题结构、进度、选项、按钮、结果和免责声明；
- 全量运行既有注册、首页和量表测试；
- 全部 JavaScript 运行 `node --check`，再运行 `git diff --check`。

## 9. 自审

- 18 题和五级选项与现有 Web 版一致；
- 没有实现 B 的算分逻辑或修改 B 文件；
- 没有把儿童患者导向成人量表；
- 没有模拟或伪造医学结果；
- 所有新增行为都有明确测试入口和失败场景；
- 无未定义占位内容。
