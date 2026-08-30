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
| GET | `/patient/comprehensive_report` | 患者 | 无 | 最新量表、七项认知、追踪、影像和模型结果 |
| POST | `/ai/chat` | 患者/研究者 | 消息及可选上下文 | AI 或显式不可用状态 |
| POST | `/care/doctor/patient/{patient_id}/tasks` | 研究者 | 任务标题、描述和截止时间 | 患者任务 |
| GET | `/care/patient/tasks` | 患者 | 无 | 患者任务列表 |
| POST | `/care/patient/tasks/{task_id}/complete` | 患者 | 无 | 更新后的任务 |
| POST | `/care/patient/messages` | 患者 | 消息内容 | 医患消息记录 |
| GET | `/care/patient/messages` | 患者 | 无 | 医患消息列表 |

## 七项认知任务契约

顺序和 ID 固定为：

1. `reaction`：Go/No-Go
2. `simple_reaction`：简单反应时
3. `stroop`：Stroop
4. `trail`：连线测试
5. `flanker`：Flanker
6. `nback`：2-back
7. `digit`：数字广度

提交结构：

```json
{
  "test_type": "simple_reaction",
  "result_json": {
    "test_name": "简单反应时",
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
- 历史别名 `gonogo`、`go_no_go` 规范为 `reaction`；`digit_span`、`digit-span` 规范为 `digit`。
- 历史字段 `avg_reaction_ms`、`correct_rate`、`duration_s`、`correct`、`wrong`、`max_span` 在服务端转换为当前 `raw_result`。
- `accuracy` 统一使用 0–100 百分数；历史 0–1 比率会乘以 100。
- 综合报告必须按照上述顺序返回已完成任务；没有完成的任务不伪造结果。
- 反应速度优先使用 `simple_reaction`，缺失时才回退到 Go/No-Go；抑制控制中的误触仍使用 `reaction.false_starts`。

## 医生端和模型接口

| 方法 | 路径 | 角色 | 用途 |
| --- | --- | --- | --- |
| POST | `/doctor/bind_patient` | 研究者 | 绑定患者 |
| GET | `/doctor/my_patients` | 研究者 | 患者列表 |
| GET | `/doctor/dashboard_stats` | 研究者 | 医生首页统计 |
| GET | `/doctor/patient/{patient_id}/report` | 研究者 | 患者综合报告 |
| POST | `/model/predict_fmri` | 患者/研究者 | 上传 `.1D`/`.csv` 并执行真实 HGST 推理 |
| POST | `/model/predict_mock` | 患者/研究者 | 明确的演示推理，不代表诊断 |

模型接口在后续任务中增加 `upload_id`、`is_demo` 和 `disclaimer`，并保证真实推理失败时不会静默回退到 Mock。

## 扩展接口

`/ai-enhanced/*` 和 `/security/*` 是 B 的研究、干预和安全扩展接口。它们保留在后端，但不作为 A 小程序主流程的必要依赖；调用方必须遵循各路由上的角色检查，不得绕过患者归属和研究者绑定校验。
