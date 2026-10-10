# AB 合并版 API 契约

基地址：`http://127.0.0.1:8000/api/v1`

鉴权方式：登录或注册成功后，将 `access_token` 作为 `Authorization: Bearer <token>` 发送。除健康检查、注册和登录外，下面的业务接口均要求有效令牌。

## 小程序直接使用的接口

| 方法 | 路径 | 角色 | 请求要点 | 响应要点 |
| --- | --- | --- | --- | --- |
| GET | `/health` | 公开 | 无 | `{status: "ok"}` |
| POST | `/auth/register` | 公开 | 邮箱、密码、姓名、角色、知情同意；患者还需 `patient_profile` | 令牌和用户资料 |
| POST | `/auth/login` | 公开 | `identifier`、密码、可选角色 | 令牌和用户资料 |
| GET | `/auth/me` | 已登录 | 无 | 当前用户与患者资料 |
| GET | `/patient/dashboard_status` | 患者 | 无 | 量表、认知、追踪和报告进度 |
| POST | `/patient/submit_scale` | 患者 | 量表类型、答题分值、答题者类型 | 量表得分、风险级别、雷达和建议 |
| POST | `/patient/submit_cognitive_test` | 患者 | `test_type`、`result_json` | 规范化后的任务类型、结果和记录时间 |
| POST | `/patient/submit_daily_log` | 患者 | 当日专注、情绪、行为、用药和备注字段 | 追踪记录 |
| GET | `/patient/comprehensive_report` | 患者 | 无 | 最新量表、认知、追踪、影像和模型结果 |
| POST | `/ai/chat` | 患者/研究者 | 消息及可选上下文 | AI 或显式不可用状态 |
| POST | `/care/doctor/patient/{patient_id}/tasks` | 研究者 | 任务标题、描述和截止时间 | 患者任务 |
| GET | `/care/patient/tasks` | 患者 | 无 | 患者任务列表 |
| POST | `/care/patient/tasks/{task_id}/complete` | 患者 | 无 | 更新后的任务 |
| POST | `/care/patient/messages` | 患者 | 消息内容 | 医患消息记录 |
| GET | `/care/patient/messages` | 患者 | 无 | 医患消息列表 |

## 六项活动认知任务与历史兼容

小程序当前顺序和 ID 固定为：

1. `reaction`：Go/No-Go
2. `stroop`：Stroop
3. `flanker`：Flanker
4. `nback`：2-back
5. `trail`：连线测试
6. `digit`：数字广度

提交结构：

```json
{
  "test_type": "reaction",
  "result_json": {
    "schema_version": 2,
    "protocol_id": "continuous-mobile-v4",
    "protocol_label": "连续移动筛查版",
    "protocol_schema_version": 6,
    "actual_trials": 25,
    "test_run_id": "wx-mg000001-example",
    "test_name": "Go/No-Go 测试",
    "status_text": "已完成",
    "finished_at": "2026-08-30T08:00:00Z",
    "metrics": [
      {"label": "平均反应时", "value": "310 ms"}
    ],
    "raw_result": {
      "average_reaction_time_ms": 310,
      "accuracy": 100
    }
  }
}
```

规则：

- 未知 `test_type` 返回 HTTP 422，不写数据库。
- `simple_reaction` 不再是小程序活动任务，但后端仍接受并展示已有的历史记录。
- 历史别名 `gonogo`、`go_no_go` 规范为 `reaction`；`digit_span`、`digit-span` 规范为 `digit`。
- 历史字段 `avg_reaction_ms`、`correct_rate`、`duration_s`、`correct`、`wrong`、`max_span` 在服务端转换为当前 `raw_result`。
- `accuracy` 统一使用 0–100 百分数；历史 0–1 比率会乘以 100。
- 综合报告只返回已完成任务；没有完成的任务不伪造结果。旧患者数据中的 `simple_reaction` 仍可用于历史报告。
- 新的小程序反应与抑制数据使用 `reaction`，其中误触使用 `reaction.false_starts`。
- 当前协议为 `continuous-mobile-v4`，协议结构版本为 6；结果结构 `schema_version` 仍为 2。成人与儿童共享连续流程，保留各自既有参数。
- Go/No-Go 正式 25 次，沿用实际 800ms 刺激响应窗口与原有随机、计分规则。Stroop、Flanker 正式各 24 次。2-back 呈现 24 次，前两次建立记忆不计分，`raw_result.total_trials` 为 22，而 `actual_trials` 为 24。
- 连线 A 为 30 个数字，B 为 15 组数字与字母、30 个节点；`actual_trials` 为 60，`raw_result.stages` 分别保存 `stage`、`nodeCount`、`elapsedMs`、`errors` 和 `completed`。B 的简短规则提示不计入任一阶段用时。
- 数字广度保留顺背/倒背和每个长度两轮的原有终止条件，`actual_trials` 为实际已作答轮数。各任务不再等待“继续下一节”。
- 新客户端为每次主动开始生成 `test_run_id`，重试沿用同一 ID。ID 为 1–64 个 ASCII 字母、数字或 `._:-`；同患者、同规范任务类型、同 ID 重复提交返回原记录，不增加认知记录及安全采集记录。历史未携带 ID 的提交继续接受，不补写或合并历史记录。
- 新协议连线节点增多，服务端展示 A/B 用时、节点及错误，并将其排除于旧连线时长和错误阈值形成的综合分数；仍使用其余原有指标，避免将新旧节点数量直接比较。

现有数据库新增可空 `cognitive_tests.test_run_id` 和 `(patient_id, test_type, test_run_id)` 唯一索引。应用启动沿用现有 schema 升级流程；也提供 `backend/sql/migrations/20261004_cognitive_run_id_{sqlite,mysql}.sql` 供部署时选择执行。不要对已有该字段的库重复执行手工脚本；本次开发未运行现有业务库升级或生产迁移。

## 医生端和模型接口

| 方法 | 路径 | 角色 | 用途 |
| --- | --- | --- | --- |
| POST | `/doctor/bind_patient` | 研究者 | 绑定患者 |
| GET | `/doctor/my_patients` | 研究者 | 患者列表 |
| GET | `/doctor/dashboard_stats` | 研究者 | 医生首页统计 |
| GET | `/doctor/patient/{patient_id}/report` | 研究者 | 患者综合报告 |
| POST | `/model/predict_fmri` | 患者/研究者 | 上传 `.1D`/`.csv` 并执行真实 HGST 推理 |
| POST | `/model/predict_mock` | 患者/研究者 | 明确的演示推理，不代表诊断 |

模型接口由 `USE_MOCK_MODEL` 决定推理模式（详见 `docs/hgst-model-integration.md`）：
- `real`（默认，留空/false/strict）：`/model/predict_fmri` 执行真实 HGST；依赖或权重缺失返回 503，**绝不静默回退到 Mock**。
- `auto`：真实优先；真实 HGST 不可用时降级为带 `is_demo=true` 的演示 Mock 并打告警日志。
- `true`（mock）：恒走演示 Mock（真上传假结果，`is_demo=true`）。

响应中的 `is_demo` 表示演示来源；真实与 Mock 均携带 `upload_id` 与免责 `disclaimer`。

## 扩展接口

`/ai-enhanced/*` 和 `/security/*` 是 B 的研究、干预和安全扩展接口。它们保留在后端，但不作为 A 小程序主流程的必要依赖；调用方必须遵循各路由上的角色检查，不得绕过患者归属和研究者绑定校验。
