# 微信小程序 Stroop 与认知结果汇总设计

日期：2026-08-21

## 1. 目标与 A/B 边界

本子项目对应 A 端 D7：新增 Stroop 颜色词测试，并把 Go/No-Go 与 Stroop 的最近一次本地客观结果汇总到认知中心。

A 负责小程序固定试次、作答计时、结果展示、本地最近结果、待同步状态、认知中心和首页入口。B 负责服务端持久化与医学聚合；本阶段只读复用 `POST /patient/submit_cognitive_test`，不修改 `backend/`、医生端或报告服务。

## 2. 页面信息架构

- `/pages/cognitive-center/index`：认知测试入口与本地完成情况；列出 Go/No-Go、Stroop 两项任务。
- `/pages/cognitive/index`：保留 D6 Go/No-Go 页面。
- `/pages/stroop/index`：新增 Stroop 说明、8 题作答、反馈和结果页。
- 患者首页的“认知测试”统一进入认知中心，避免直接跳过任务选择与结果汇总。

## 3. Stroop 固定范式

使用红、绿、蓝、黄四种颜色，固定 8 题平衡序列。页面显示一个颜色词，字体颜色可能与文字含义一致或冲突；患者必须选择“字体实际颜色”。固定序列便于比赛演示、自动测试和问题复现，不宣称等同于临床标准化随机范式。

每题从出现提示开始用 `Date.now()` 计时。选择后记录：题号、文字含义、实际颜色、所选颜色、是否正确、非负整数反应时。短暂反馈 350 毫秒后进入下一题，反馈期间禁止重复作答。

结果字段：

```js
{
  total_trials: 8,
  correct: 0,
  wrong: 0,
  accuracy: 0,
  average_reaction_time_ms: 0,
  fastest_reaction_time_ms: 0,
  congruent_accuracy: 0,
  incongruent_accuracy: 0
}
```

接口 payload 保持现有 B 契约：

```js
POST /patient/submit_cognitive_test
{
  test_type: 'stroop',
  result_json: {
    test_name: 'Stroop 测试',
    status_text: '已完成测试',
    summary: '仅描述测试已完成及指标含义',
    metrics: [{ label: '正确率', value: '75%' }],
    raw_result: { ...客观指标 },
    finished_at: 'ISO 时间'
  }
}
```

## 4. 本地认知汇总

`utils/cognitive-results.js` 只处理纯数据：校验 `reaction/stroop` payload、合并最近结果、生成两张任务卡、完成数量和进度。页面通过 `cognitive_latest_results` 保存最近结果，不保存姓名、邮箱、token 或逐题敏感内容。

Go/No-Go payload 在 D7 补充与后端报告契约兼容的 `test_name/status_text/summary/metrics`，保留 D6 的 `test_variant/raw_result/finished_at`。两项任务均“先保存本地客观结果，再尝试接口同步”。接口失败只标记待同步，绝不显示为已同步。

认知中心文案只分三种客观状态：0/2 未开始、1/2 继续完成、2/2 两项已完成。不得根据本地指标生成 ADHD 风险、诊断或治疗建议。

## 5. 生命周期与异常

- Stroop 开始、作答、提交均有重复操作保护；
- 页面卸载清除反馈定时器；
- 未完成 8 题不得构造正式 payload；
- 非法颜色和无效记录不计入正式结果；
- 每种任务使用独立待同步 key，避免相互覆盖；
- 本地最近结果损坏时忽略该项并回到未完成状态；
- 返回认知中心后通过 `onShow` 重新读取最新结果。

## 6. 验收

- 纯逻辑覆盖固定题目、正确/错误、反应时、相容/冲突准确率、payload 和本地汇总；
- 页面控制测试覆盖连续作答、重复点击、完成、本地保存、同步成功/失败、重试和卸载；
- 结构测试覆盖说明、颜色按钮、进度、反馈、结果、同步状态、认知中心和免责声明；
- 首页进入认知中心，两项卡片分别进入正确页面；
- 全量 Node 测试、JavaScript 语法、JSON 与 Git 空白检查通过；
- 真机色彩辨识、按钮触摸和 350 毫秒节奏列入 D13 人工验收。

## 7. 自审结论

- 功能严格落在 A 的原生小程序范围；
- 使用 B 已存在的通用提交契约，不扩写后端；
- 固定范式、字段和异常路径可测试、可复现；
- 本地汇总只表示完成与客观表现，不越权做医学判断；
- 与 D6 的本地结果和离线策略兼容。
