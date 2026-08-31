# 微信小程序 Go/No-Go 认知测试设计

日期：2026-08-21

## 1. 目标与范围

本子项目对应 A 端 D6：实现原生微信小程序 Go/No-Go 触摸测试，用于记录即时反应速度和抑制控制表现。

A 实现测试序列、计时、触摸反馈、本地指标、结果页面、待同步记录和首页入口。B 负责持久化接口；本阶段不修改 `backend/`。

## 2. 测试范式

正式测试包含 10 轮固定混合序列：6 个 GO 和 4 个 NO-GO。固定序列便于比赛演示和自动复现，不声称达到临床科研范式的随机化强度。

- 等待阶段：800—1400 毫秒后显示刺激；提前点击计为误触。
- GO：显示绿色圆形和“点击”；800 毫秒内点击为正确，记录反应时；未点击为遗漏。
- NO-GO：显示红色圆形和“停”；800 毫秒内不点击为正确抑制；点击为冲动错误。
- 每轮反馈 450 毫秒后进入下一轮。

页面明确说明这是辅助筛查任务，不替代专业认知评估。

## 3. 纯逻辑与页面边界

- `utils/gonogo-test.js`：固定试次、单轮判定、准确率和反应时汇总、接口 payload；不访问时间、定时器或 `wx`。
- `pages/cognitive/index.js`：管理阶段、`setTimeout`、`Date.now`、触摸、请求和本地待同步记录。
- WXML/WXSS：介绍、测试区、刺激、反馈、进度和结果。

测试结果字段：

```js
{
  total_trials: 10,
  correct_trials: 0,
  accuracy: 0,
  go_accuracy: 0,
  nogo_accuracy: 0,
  average_reaction_time_ms: 0,
  fastest_reaction_time_ms: 0,
  commission_errors: 0,
  omission_errors: 0,
  false_starts: 0
}
```

## 4. 接口与离线策略

调用现有契约：

```js
POST /patient/submit_cognitive_test
{
  test_type: 'reaction',
  result_json: {
    test_variant: 'go_nogo',
    raw_result: { ...指标 },
    finished_at: 'ISO 时间'
  }
}
```

接口成功时标记“已同步”；接口失败时仍展示本地客观结果，并保存到 `pending_cognitive_result`，状态明确显示“待同步”。本地记录不含姓名、邮箱或 token。

## 5. 安全与生命周期

- `onUnload` 清除所有定时器，防止离开页面后继续更新；
- `startTest` 和提交均防重复；
- 完成前不能伪造结果；
- 反应时由 `Date.now()` 差值产生并限制为非负整数；
- 结果仅描述任务表现，不输出 ADHD 诊断结论。

## 6. 验收

- 纯逻辑覆盖 GO 正确、NO-GO 正确、冲动错误、遗漏、误触和汇总边界；
- 页面使用可控计时器测试启动、刺激、点击、自动超时、完成、同步成功/失败和卸载清理；
- 首页两类患者均可进入认知测试；
- 全量 Node、JavaScript 语法和 Git 空白检查通过；
- 工作记录写明自动化证据与未执行的真机触摸验收。

## 7. 自审

- 没有把简单反应时按钮误写成完整 Go/No-Go；
- 固定 10 轮和时间窗口均明确；
- 本地结果与后端同步状态可区分；
- 没有修改 B 文件或伪造接口成功；
- 无医学诊断性文案或未定义占位内容。
