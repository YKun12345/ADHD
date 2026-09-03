# 医生端 Web 人工验收清单（doctor-web）

- 生成日期：2026-09-03
- 状态：**待人工执行**。自动测试不能代替本清单，本清单只覆盖医生端浏览器验收，不能证明医学有效性或临床/生产合规性。
- 关联文档：[`manual-acceptance.md`](./manual-acceptance.md)（总验收模板，本文件是其“医生 / 研究人员 Web”一节的细化执行手册）、[`api-contract.md`](./api-contract.md)、`doctor-web/README.md`、根 `README.md`。

---

## 0. 前置与运行环境

| 项 | 要求 / 命令 |
|---|---|
| 后端 | 从仓库根目录启动：`python -m backend.create_tables` →（可选）`python -m backend.scripts.seed_demo_data` → `uvicorn backend.app.main:app --host 127.0.0.1 --port 8000` |
| 医生端入口 | `http://127.0.0.1:8000/doctor-web/`（静态托管于 FastAPI，勿用 `file://` 打开页面） |
| API 根 | `http://127.0.0.1:8000/api/v1`（OpenAPI：`/docs`） |
| 数据库 | 开发默认 SQLite（`backend/app.db`）；MySQL 见 `backend/sql/init_mysql.sql` + `backend/.env` 的 `DATABASE_URL` |
| 浏览器 | Chrome/Edge 最新；验收前清除该站 `localStorage`，避免旧 token 干扰 |
| 真实 HGST | 影像真实推理需 HGST 运行时与权重（见根 README“模型和医疗边界”）。推理模式由 `USE_MOCK_MODEL` 决定（见 `docs/hgst-model-integration.md`）：本清单按**默认真实模式**验收（未设/`false`/`strict`），该模式下无权重时真实推理应返回 503 且不得静默 Mock——这是预期安全行为，见 §4 排查 I-4/I-5；设 `true`/`auto` 时 D5 需按演示口径理解 |

演示账号（由种子脚本创建，密码均为 `Demo#2026`）：

| 账号 | 角色 | 用途 |
|---|---|---|
| `doctor@demo.com` | 研究者（normal） | 医生端登录，默认绑定“演示成人患者”“演示儿童患者” |
| `adult@demo.com` | 患者（成人 ASRS 高风险） | 小程序端 |
| `child@demo.com` | 患者（儿童 SNAP-IV 低风险） | 小程序端 |
| `dac@demo.com` | 研究者（DAC 审计） | DAC 审计台（越权/审计抽查） |

---

## 1. 测试数据准备

### 方案 A（推荐）：官方种子脚本

可重复执行、不膨胀数据；会打印演示账号。

```bash
python -m backend.scripts.seed_demo_data
```

- 已在 `doctor@demo.com` 名下创建成人(ASRS 高风险)+儿童(SNAP-IV 低风险)两名患者，附 7 类认知测试、14 天追踪日志、影像摘要、DemoMock 演示预测。
- 种子脚本在 `APP_ENV=production` 下会拒绝运行；演示数据不含真实患者资料。

### 方案 B：自建测试数据 SQL

适用：**全新数据库（只执行过 `create_tables`，未跑过种子）**，或用独立 QA 账号便于事后清理。
下列 SQL 在 SQLite 与 MySQL 8 均可用。若库中已有同名邮箱/主键（例如已跑过种子），请改用方案 A，或先执行 §1.4 清理语句。

约定：成人用 ASRS（高风险，用于验证中/高风险的视觉与建议），儿童用 SNAP_IV（中风险）。
所有账号密码统一为 `Demo#2026`（下列 `password_hash` 即该口令的合法 bcrypt 值；若想改口令，用 `python -c "from backend.app.core.security import get_password_hash;print(get_password_hash('新口令'))"` 生成后替换）。

#### 1.1 账号与患者档案

```sql
-- 1) 医生账号（researcher / normal）
INSERT INTO users
  (id, email, full_name, password_hash, role, subrole, consent_agreed, is_active, created_at)
VALUES
  (1, 'qa-doctor@demo.com', '验收医生',
   '$2b$12$vFd9PcF79KijIWXHY9kEBe6bUWJr66q6LOU.PXwSCZGxMDjUsE7ou',
   'researcher', 'normal', 1, 1, '2026-09-03 09:00:00');

-- 2) 成人患者账号
INSERT INTO users
  (id, email, full_name, password_hash, role, subrole, consent_agreed, is_active, created_at)
VALUES
  (2, 'qa-adult@demo.com', '验收成人患者',
   '$2b$12$vFd9PcF79KijIWXHY9kEBe6bUWJr66q6LOU.PXwSCZGxMDjUsE7ou',
   'patient', NULL, 1, 1, '2026-09-03 09:01:00');

-- 3) 儿童患者账号
INSERT INTO users
  (id, email, full_name, password_hash, role, subrole, consent_agreed, is_active, created_at)
VALUES
  (3, 'qa-child@demo.com', '验收儿童患者',
   '$2b$12$vFd9PcF79KijIWXHY9kEBe6bUWJr66q6LOU.PXwSCZGxMDjUsE7ou',
   'patient', NULL, 1, 1, '2026-09-03 09:02:00');

-- 4) 患者档案（user_id 2=成人、3=儿童；均绑定医生 id=1）
INSERT INTO patients (id, user_id, assigned_researcher_id, age, gender, patient_type, created_at)
VALUES (1, 2, 1, 20, 'male',   'adult', '2026-09-03 09:03:00');

INSERT INTO patients (id, user_id, assigned_researcher_id, age, gender, patient_type, created_at)
VALUES (2, 3, 1,  9, 'female', 'child', '2026-09-03 09:04:00');
```

#### 1.2 量表结果

成人 ASRS（id=1，绑定患者 1）：18 题 `[4,3,4,3,3,4,3,3,2,3,4,3,3,4,3,3,2,2]`，总分 56，**high**。

```sql
INSERT INTO scale_results
  (id, patient_id, scale_type, score_json, total_score, risk_level, created_at)
VALUES
  (1, 1, 'ASRS',
   '{"answers":[4,3,4,3,3,4,3,3,2,3,4,3,3,4,3,3,2,2],"respondent_type":"self","sub_scores":{"part_a_positive":6.0,"attention_deficit":29,"hyperactivity_impulsivity":27},"radar_scores":{"attention_control":16.2,"organization":16.2,"task_activation":16.7,"hyperactivity":16.7,"impulsivity":12.5},"summary":"成人量表提示核心注意控制与执行启动困难较明显，建议尽快结合认知测试与医生访谈进一步评估。","recommendations":["建议尽快预约专业医生或心理评估师进行进一步诊断。","尝试使用固定时间块、任务拆分和提醒工具来降低执行启动成本。","优先记录学习或工作中最容易分心的场景，为后续干预提供线索。","建议继续完成认知测试与14天追踪，以形成更稳定的多模态评估基线。","量表结果仅用于辅助筛查，不替代医生面对面诊断。"]}',
   56, 'high', '2026-09-03 09:10:00');
```

儿童 SNAP_IV（id=2，绑定患者 2）：26 题 `[2,1,2,1,1,2,1,1,1,1,1,1,1,0,1,1,1,1,1,1,0,1,0,1,1,0]`，总分 25，**medium**。

```sql
INSERT INTO scale_results
  (id, patient_id, scale_type, score_json, total_score, risk_level, created_at)
VALUES
  (2, 2, 'SNAP_IV',
   '{"answers":[2,1,2,1,1,2,1,1,1,1,1,1,1,0,1,1,1,1,1,1,0,1,0,1,1,0],"respondent_type":"parent","sub_scores":{"attention_mean":1.33,"hyperactivity_mean":0.89,"oppositional_mean":0.62},"radar_scores":{"attention_control":9.3,"organization":8.3,"hyperactivity":5.3,"impulsivity":6.7,"emotional_regulation":4.2},"summary":"儿童量表提示存在一定症状倾向，建议继续完成认知测试与14天追踪并关注多场景表现。","recommendations":["建议由家长与教师共同观察并记录孩子在家庭与学校中的差异表现。","可优先关注课堂专注、作业完成和情绪对立等高频场景。","建议继续完成认知测试与14天追踪，以形成更稳定的多模态评估基线。","量表结果仅用于辅助筛查，不替代医生面对面诊断。"]}',
   25, 'medium', '2026-09-03 09:11:00');
```

> 口径说明：`score_json` 的键与 `backend/app/schemas/scale.py` 的 `ScaleResultResponse`（`radar_scores`/`sub_scores`/`summary`/`recommendations`）一致；量表算法见 `backend/app/api/routes/patient.py` 的 `_asrs_scores`/`_snap_scores`。

#### 1.3 追踪日志（儿童 7 天，用于验证“进行中”追踪态）

一天一行，`patient_id + day_index` 有唯一约束（`uq_tracking_logs_patient_day`），**勿重复插入同一天**。

```sql
INSERT INTO tracking_logs
  (id, patient_id, day_index, mood_tag, focus_minutes, note, test_score, activities,
   is_medication, medication_dosage, attention_rating, hyperactivity_rating,
   impulsivity_rating, emotion_rating, task_completion_rating,
   sleep_quality, appetite_quality, has_conflict, was_criticized, created_at)
VALUES
  (1, 2, 1, '3', 35, '第 1 天生活记录', 0.60, '阅读、写作业', 0, NULL, 3, 2, 2, 3, 3, '一般', '正常', 0, 0, '2026-09-03 09:20:00'),
  (2, 2, 2, '4', 40, '第 2 天生活记录', 0.68, '阅读、写作业', 1, '0.3mg', 4, 3, 3, 4, 4, '好',   '正常', 0, 0, '2026-09-03 09:21:00'),
  (3, 2, 3, '3', 45, '第 3 天生活记录', 0.60, '户外活动',     0, NULL, 3, 2, 2, 3, 3, '一般', '正常', 0, 0, '2026-09-03 09:22:00'),
  (4, 2, 4, '4', 50, '第 4 天生活记录', 0.76, '写作业',       1, '0.3mg', 4, 3, 3, 4, 4, '好',   '正常', 0, 0, '2026-09-03 09:23:00'),
  (5, 2, 5, '3', 40, '第 5 天有冲突',   0.68, '阅读',         0, NULL, 3, 2, 2, 3, 3, '一般', '正常', 1, 1, '2026-09-03 09:24:00'),
  (6, 2, 6, '4', 45, '第 6 天生活记录', 0.76, '户外活动',     1, '0.3mg', 4, 3, 3, 4, 4, '好',   '正常', 0, 0, '2026-09-03 09:25:00'),
  (7, 2, 7, '3', 35, '第 7 天生活记录', 0.60, '写作业',       0, NULL, 3, 2, 2, 3, 3, '一般', '正常', 0, 0, '2026-09-03 09:26:00');
```

（按 `_extract_tracking_summary`：7 个去重 `day_index` → `completed_count=7`、`current_day=8`、`completion_status="in_progress"`、`consecutive_missed_days=7`。）
成人患者（患者 1）不插日志，用于验证报告“追踪未启动”空态。需要补到 14 天时复制第 8–14 天并按同规则编号即可。

#### 1.4 校验与清理

```sql
-- 校验
SELECT u.email, u.role, p.id AS patient_id, p.patient_type, p.age, p.gender, r.email AS doctor
FROM users u JOIN patients p ON p.user_id = u.id
LEFT JOIN users r ON r.id = p.assigned_researcher_id
ORDER BY p.id;

SELECT id, patient_id, scale_type, total_score, risk_level FROM scale_results ORDER BY id;
SELECT patient_id, day_index, mood_tag, focus_minutes, attention_rating FROM tracking_logs ORDER BY patient_id, day_index;

-- 清理（按 email 精确删除，顺序满足外键）
DELETE FROM tracking_logs WHERE patient_id IN (SELECT id FROM patients WHERE user_id IN
  (SELECT id FROM users WHERE email IN ('qa-adult@demo.com','qa-child@demo.com')));
DELETE FROM scale_results  WHERE patient_id IN (SELECT id FROM patients WHERE user_id IN
  (SELECT id FROM users WHERE email IN ('qa-adult@demo.com','qa-child@demo.com')));
DELETE FROM patients WHERE user_id IN (SELECT id FROM users WHERE email IN ('qa-adult@demo.com','qa-child@demo.com'));
DELETE FROM users    WHERE email IN ('qa-doctor@demo.com','qa-adult@demo.com','qa-child@demo.com');
```

#### 1.5 准备影像上传用 .1D 样例（可选）

上传接口只接受 `.1D`/`.csv`（`backend/app/services/upload_storage.py`），数据为文本数值表（推荐 AAL90/AAL116，即 90 或 116 列 × N 行时间点，见 `hgst_runtime/preprocessing.py`），默认大小上限 10 MB。

```bash
# 用仓库 .venv 生成 116 列 × 120 行的随机样例（仅演示体积/格式，真实推理需合格权重与数据）
python - <<'PY'
import random
rows = [[f"{random.uniform(-5,5):.6f}" for _ in range(116)] for _ in range(120)]
with open("sample_fmri.1D","w",encoding="ascii") as f:
    for r in rows: f.write("\t".join(r)+"\n")
print("sample_fmri.1D written: 120 rows x 116 cols")
PY
```

---

## 2. 验收清单（医生端浏览器走查）

图例：`PASS`＝符合预期；`FAIL`＝不符合；`BLOCK`＝环境依赖阻塞（需在报告注明原因与后续项）。
“实际结果”与“是否通过”在验收时填写。

### A. 登录与入口

| 序号 | 功能点 | 操作步骤 | 预期结果 | 实际结果 | 是否通过 |
|:--|:--|:--|:--|:--|:--|
| A1 | 入口可达与重定向 | 浏览器打开 `http://127.0.0.1:8000/doctor-web/` | 自动重定向到 `login.html`，登录页正常显示，无 404/脚本报错；地址为 http 且非 `file://` | | |
| A2 | 医生正确登录 | 输入 `doctor@demo.com` / `Demo#2026`，医生角色登录 | 登录成功，进入医生首页 `doctor_analysis.html`；`localStorage` 出现 `smartbrain_token`、`smartbrain_user`（Network 中 `POST /api/v1/auth/login` 返回 200 与 token） | | |
| A3 | 密码错误 | 输入 `doctor@demo.com` / 错误密码 | 明确提示账号或密码错误（401，`Incorrect account or password.`），不清空跳转、不泄漏堆栈 | | |
| A4 | 角色错配/禁用 | 用小程序的**患者**账号走医生登录；或把某账号 `is_active=0` 后登录 | 提示角色不匹配（403）或账号已禁用（403），不进入医生台 | | |
| A5 | DAC 分流 | 用 `dac@demo.com` / `Demo#2026` 登录 | 进入 `dac_dashboard.html`（DAC 审计台），而非医生患者工作台 | | |

### B. 患者列表 `/doctor/my_patients`

| 序号 | 功能点 | 操作步骤 | 预期结果 | 实际结果 | 是否通过 |
|:--|:--|:--|:--|:--|:--|
| B1 | 进入患者列表 | 医生首页 `doctor_analysis.html` 点击进入“就诊者工作台/患者列表”`doctor_patients.html` | 页面成功加载；`GET /api/v1/doctor/my_patients` 返回 200 | | |
| B2 | 列表字段正确 | 核对种子方案下两条记录 | 显示两名患者：成人患者（ASRS、高风险）、儿童患者（SNAP_IV、低风险）；每行含姓名/邮箱/患者类型/最新量表(类型+风险+总分)/追踪完成天数/认知/影像标记/下一步建议文案，与库内数据一致（方案 B 下应为成人 high、儿童 medium） | | |
| B3 | 数量与排序 | 观察列表 | `total` 与展示条数一致；按 `created_at desc, id desc` 排序 | | |
| B4 | 空态与权限隔离 | （可选）用未绑定任何患者的空医生账号，或另一医生账号登录 | 空账号显示空态提示；只能看到**绑定给自己的**患者；直接调他人患者的报告/任务接口应 404/403 | | |

### C. 患者综合报告 `/doctor/patient/{id}/report`

| 序号 | 功能点 | 操作步骤 | 预期结果 | 实际结果 | 是否通过 |
|:--|:--|:--|:--|:--|:--|
| C1 | 进入报告页 | 患者行点击“查看综合分析” | 跳转 `doctor_report.html?patient_id=…`；`GET /doctor/patient/{id}/report` 200；头部显示姓名/邮箱/患者类型 | | |
| C2 | 量表板块 | 观察成人（ASRS）报告 | 显示量表徽章（ASRS）、风险徽章（高风险）、总分、雷达图与建议/免责声明；建议含“尽快预约专业医生进一步诊断” | | |
| C3 | 量表板块（儿童） | 观察儿童（SNAP_IV）报告 | 显示 SNAP_IV 中风险，总分 25；雷达/建议正常（方案 A 种子儿童为低风险） | | |
| C4 | 追踪板块 | 种子患者：14 天已完成 | 显示 14/14 完成、趋势折线、平均情绪/专注时长与最新日志摘录 | | |
| C5 | 追踪板块（空态/进行中） | 方案 B 儿童 / 成人 | 儿童显示 7/14 “进行中”；成人显示“追踪尚未启动”空态文案 | | |
| C6 | 认知板块 | 种子患者 | 认知雷达 + 最近七类测试摘要正常（种子）；方案 B 无认知数据时为空态（属预期） | | |
| C7 | 影像与模型预测摘要 | 种子患者 | 影像可视化摘要 + 模型预测（DemoMock，含红色“演示 Mock”提示与“不可用于诊断”免责）；`is_demo` 文案可见 | | |
| C8 | 报告总体与安全概览 | 打开控制台 | 报告各板块按缺省顺序渲染且无 JS 报错；报告页伴随 `GET /security/patient/{id}/overview` 正常返回 | | |

### D. 影像上传（.1D）与预测

| 序号 | 功能点 | 操作步骤 | 预期结果 | 实际结果 | 是否通过 |
|:--|:--|:--|:--|:--|:--|
| D1 | 进入影像分析页 | 报告页点击“查看影像分析” | 跳 `doctor_imaging.html?patient_id=…`；页面提示支持 AAL90/AAL116 的 `.1D`/`.csv` | | |
| D2 | 选择并展示文件 | 点上传区选择 `sample_fmri.1D`（或拖拽） | 文件名出现在上传区，文件选择框 accept 限定 `.1d/.1D/.csv` | | |
| D3 | 非法文件被拦 | 选择 `.txt`/`.png` 后点“开始分类推理” | 前端 accept 即拦截；若绕过前端，后端应 400（仅支持 .1D/.csv），错误信息可理解 | | |
| D4 | 超限文件 | 上传 >10 MB 文件 | 413，错误信息可理解（默认 `UPLOAD_MAX_BYTES=10MB`） | | |
| D5 | 真实推理成功（默认真实模式 + **有 HGST 运行时/权重**时） | 对某患者上传合格 AAL90/116 `.1D` | 推理完成；`ModelPrediction` 入库（`source_type=fmri_hgst`），报告“模型预测”板块回填 ADHD/Control 概率条，免责为“Screening support only”（非演示） | | |
| D6 | 默认真实模式下**不静默 Mock**（安全边界） | 对未装 HGST 的环境（`USE_MOCK_MODEL` 未设/`false`）上传合法 `.1D` | 后端 503（HGST 不可用）或 422（数据不合格），前端给出可理解失败提示；**不**生成伪造预测，报告不出现新的 mock 结果 | | |
| D7 | 演示预测标识（供无权重环境联调 UI） | 用接口给方案 B 患者造一条演示预测后回报告页 | 报告“模型预测”板块显示红色“演示 Mock”+免责“Demonstration output only; not a medical diagnosis.”。命令见 §5 F7 | | |

### E. 任务下发 `/care/doctor/patient/{id}/tasks`

| 序号 | 功能点 | 操作步骤 | 预期结果 | 实际结果 | 是否通过 |
|:--|:--|:--|:--|:--|:--|
| E1 | 打开下发面板 | 在患者列表某患者行展开“研究人员推送任务” | 下拉含 `scale/cognitive/tracking/report_review` 四类，含标题/说明输入与“推送任务”按钮 | | |
| E2 | 下发“量表”任务 | 任务类型选 `scale`，填标题“请完成 ASRS 评估”，推送 | `POST /care/doctor/patient/{id}/tasks` 201；该患者任务块出现该任务，`status=pending`、`target_page=/pages/scale/index` | | |
| E3 | 下发其余三类任务 | 分别选 `cognitive/tracking/report_review` 再推送 | 各生成一条 pending 任务；目标页映射依次为 `/pages/cognitive-center/index`、`/pages/tracking/index`、`/pages/report/index` | | |
| E4 | 参数校验 | 空标题/超长说明 | 被拦或 400，前端提示；不产生脏数据 | | |
| E5 | 越权/目标不存在 | 推给非本人绑定的患者 | 404（不属于当前医生），不泄露他人信息 | | |

### F. 小程序接收任务闭环（切换微信开发者工具）

| 序号 | 功能点 | 操作步骤 | 预期结果 | 实际结果 | 是否通过 |
|:--|:--|:--|:--|:--|:--|
| F1 | 患者登录 | 用对应**患者**账号（种子 `child@demo.com` 或方案 B `qa-child@demo.com`，密码 `Demo#2026`）登录小程序 | 登录成功；服务器地址正确指向 `/api/v1` | | |
| F2 | 任务入口可见 | 回到首页触发 `onShow` | 首页出现“我的任务”入口与待办徽标（基于 `GET /care/patient/summary`）；进入 `/pages/patient-tasks/index` | | |
| F3 | 任务列表展示 | 停留在患者任务页（每次 `onShow` 拉取 `GET /care/patient/tasks`） | 显示医生下发任务：标题/医生名/类型/截止时间/`pending` 状态 | | |
| F4 | 跳转目标页 | 点任务卡片“前往任务” | 只跳转白名单映射页面（见 E2/E3），如量表任务→量表页 | | |
| F5 | 标记完成 | 返回任务列表点“标记完成” | `POST /care/patient/tasks/{id}/complete` 成功，状态变 `completed`；已过期任务不显示可完成或返回 409 | | |
| F6 | 医生端回显闭环 | 切回医生端刷新该患者任务块 | 该任务状态同步为已完成（`GET /care/doctor/patient/{id}/tasks` 可见 `completed` 与完成时间） | | |
| F7 | （可选）演示预测命令 | `python` 或 `curl` 调用 `predict_mock` 后医生端回报告页核对 D7 文案 | 见 D7 | | |

### G. 一致性与健壮性抽查

| 序号 | 功能点 | 操作步骤 | 预期结果 | 实际结果 | 是否通过 |
|:--|:--|:--|:--|:--|:--|
| G1 | 401/网络错误可读 | 清空 token 后进入需登录页；或停掉后端再刷新 | 跳回登录或给出“后端不可用/登录过期”可理解提示，不展示原始堆栈或密钥 | | |
| G2 | 越权边界 | 用患者 token 调医生接口；医生 token 调他人报告 | 401/403/404，无数据越权 | | |
| G3 | Mock 边界 | 检查所有含“演示 Mock”页 | Mock 仅来自 `source_type="mock"` 的记录；真实失败不降级成 Mock（可对照 D6） | | |

---

## 3. 验收报告模板

> 复制下方到独立回执文件（如 `docs/history/YYYY-MM-DD-doctor-web-acceptance-report.md`）后填写。

```markdown
# 医生端 Web 验收报告

## 1. 验收基本信息
- 验收对象：ADHD 医生端 Web（doctor-web，浏览器人工验收）
- 日期 / 执行人 / 复核人：
- 代码版本（git rev / 分支）：
- 依赖清单：见 `docs/evidence/delivery-manifest.json` 与 `web-dependency-report.json`

## 2. 验收环境
- 系统/浏览器版本：
- 数据库（SQLite/MySQL 及连接串要点，不含口令）：
- 是否安装真实 HGST 运行时与权重：是 / 否（影响 D5/D6）
- 推理模式 `USE_MOCK_MODEL`（空/true/auto，影响 D5–D7 结论口径）
- 服务地址：http://127.0.0.1:8000/doctor-web/
- 测试数据方案：A 种子 / B 自建 SQL（勾选）

## 3. 使用账号
| 角色 | 账号 | 用途 | 结果 |
|---|---|---|---|
| 研究者 | doctor@demo.com（或 qa-doctor@demo.com） | 医生端 |  |
| 患者 | child@demo.com（或 qa-child@demo.com） | 小程序闭环 |  |
| DAC | dac@demo.com | 审计抽查 |  |

## 4. 结论汇总
- 总条目：____ / 通过：____ / 失败：____ / 阻塞（环境）：____
- 是否满足“医生端核心流程可完整走通”：是 / 否

## 5. 逐项结果（引用 §2 序号）
| 序号 | 实际结果摘录 | 截图/证据路径 | 是否通过 |
|---|---|---|---|
| A1 |  |  |  |

## 6. 未通过 / 缺陷清单
| 序号 | 严重程度(高/中/低) | 现象与影响 | 复现步骤 | 期望行为 | 负责人 | 状态 |
|---|---|---|---|---|---|---|

## 7. 边界与风险说明
- 影像真实推理依赖 HGST 环境；未安装时 D5 标记 BLOCK，D6/D7 通过即视为满足安全边界。
- Mock 与免责声明在页面可见性；DAC 越权由项目负责人复核。

## 8. 签字
- 执行人签字 / 复核人签字 / 项目负责人签字：
- 签署版本号 / 提交号 / 验收日期：
- 未解决缺陷清单与回滚方案：
```

---

## 4. 常见问题排查

### 4.1 登录失败

先用 `curl` 定位是“认证失败”还是“连不上后端”：

```bash
curl -i -X POST http://127.0.0.1:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identifier":"doctor@demo.com","password":"Demo#2026","role":"researcher"}'
```

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `401 Incorrect account or password.` | 账号/口令不符 | 确认用对账号与 `Demo#2026`；方案 B 自建账号需先确认 `password_hash` 是当前 `backend/.env` 同算法生成的 bcrypt（用 `verify_password` 验证） |
| `403 Selected role does not match` | 页面按“医生”登录但账号是患者角色（患者应去小程序） | 换 researcher 账号，或核对 `role` 传参 |
| `403 This account has been disabled.` | `users.is_active=0` | 用 `UPDATE users SET is_active=1 WHERE email=...` 或换账号 |
| 登录成功即被踢回登录页 | 旧 token / 服务端重启后密钥变化 | 清 `localStorage`（`smartbrain_token`/`smartbrain_user`）重登；或换浏览器无痕 |
| `fetch failed` / 一直转圈 | 后端未启动 / 端口不对 / `api.js` 兜底地址 `127.0.0.1:8000` 与部署不一致 | 确认 uvicorn 起来；多网卡时用 `window.SMARTBRAIN_API_BASE_URL` 覆盖或改 `api.js` 的 base（同源通常免配） |
| 数据返回 401 但刚登录过 | token 过期（默认签发时长） | 重新登录；检查浏览器时间是否漂移（JWT 校验依赖时间） |

### 4.2 接口返回 500（或页面白屏/某板块报错）

1. **先看后端日志**：uvicorn 控制台的 Python traceback 才是根因；浏览器控制台 500 只是结果。
2. 常见根因与对策：
   - **表结构没建/旧库缺列**：全新建库执行 `python -m backend.create_tables`；已有 MySQL 旧库按 `backend/sql/migrations/20260830_model_prediction_upload_link_mysql.sql` 处理（先备份）。
   - **重插追踪日志**：`tracking_logs` 有 `(patient_id, day_index)` 唯一约束，重复插入同一患者同一天会失败——先 `DELETE` 再插（见 §1.4）。
   - **JSON/日期字段写入不合规**：`score_json` 必须是合法 JSON；`created_at` 用 `YYYY-MM-DD HH:MM:SS` 格式。
   - **数据被破坏 / 脏数据**：对比 §1.4 的 SELECT 结果与接口返回；必要时删 `backend/app.db` 重建后重新种子（仅限演示库）。
   - **上传相关**：见 4.4。
3. 定位口径：`GET /api/v1/health` 正常但业务 500 → 多为数据/依赖问题；健康检查也挂 → 环境/配置问题。

### 4.3 任务下发失败 / 小程序看不到任务

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 医生点“推送任务”报 403 | 当前登录账号不是 researcher（normal） | 用 `doctor@demo.com`/`qa-doctor@demo.com` 登录 |
| 报 404（患者不存在/无权限） | 患者未绑定当前医生，或绑给了别人 | 患者列表必须由该医生处能看到目标患者；绑定关系在 `patients.assigned_researcher_id` |
| 表单无法提交/400 | 空标题、超长字段、类型不在枚举内 | 类型限 `scale/cognitive/tracking/report_review`（医生端下拉范围）；标题 ≤120 字 |
| 小程序任务页是空的 | 患者端账号没登录 / 拉取靠每次 `onShow`（无轮询），或页面停留过久 | 重新进入任务页触发 `onShow` 刷新；确认 `wx.getStorageSync('access_token')` 是**患者**的 token |
| 任务出现但无法“标记完成” | 任务 `due_at` 已过 → 后端把过期任务按 `expired` 展示并拒绝完成（409） | 下发时给足截止时间；已过期任务在医生端重发新任务 |
| 点“前往任务”跳不到对应页 | 目标页不在白名单/版本不含该页 | 核对任务映射表（scale→/pages/scale/index 等）与小程序页面存在性 |

### 4.4 影像上传（.1D）失败

接口 `POST /api/v1/model/predict_fmri?patient_id={id}`（`multipart` 字段名 `timeseries_file`）。

| 状态 | 含义与处理 |
|---|---|
| 400 | 仅支持 `.1D`/`.csv`，或文件为空 → 换合格文件 |
| 413 | 超过 `UPLOAD_MAX_BYTES`（默认 10 MB）→ 压缩/分段或调大配置 |
| 422 | HGST 推理数据不合格（非 AAL90/116 列数、时间点不足等）→ 核对文件数值表结构 |
| 503 | HGST 运行时/权重缺失（`HGSTUnavailableError`）→ **属预期（默认真实模式）**：装真实依赖（见根 README），或设 `USE_MOCK_MODEL=true`/`auto` 走演示预测联调 UI；默认 real 模式后端不静默 Mock |
| 500 | 推理异常 → 看后端 traceback；上传记录会标记 `failed` |
| 上传成功但报告没回填 | 预测记录归属患者/医生与当前查看不一致；或推理失败已 `failed` | 查 `uploads.status` 与 `model_predictions` 是否新增 |

### 4.5 其它

- **Mock 标识没出现**：`is_demo` 仅当 `model_predictions.source_type='mock'` 才为真；真实推理（`fmri_hgst`）显示“Screening support only”免责，二者不要混淆。
- **DAC 页面预期**：`dac@demo.com` 登录后进入 DAC 审计台（非医生工作台）；DAC 越权与审计记录由项目负责人复核。
- **彻底重来（仅演示库）**：停 uvicorn → 删除 `backend/app.db` → `python -m backend.create_tables` → `python -m backend.scripts.seed_demo_data` → 重启。

---

## 5. 附录：医生端相关接口速查

| 接口 | 方法 | 角色 | 说明 |
|---|---|---|---|
| `/auth/login`、`/auth/me` | POST/GET | 任意 | 登录、当前用户 |
| `/doctor/my_patients` | GET | researcher | 患者列表 |
| `/doctor/patient/{id}/report` | GET | researcher | 综合报告 |
| `/doctor/patient/{id}/imaging_visualization` | POST | researcher | 保存影像可视化记录 |
| `/care/doctor/patient/{id}/tasks` | GET/POST | researcher | 下发/查看任务 |
| `/care/patient/tasks`、`/care/patient/tasks/{id}/complete` | GET/POST | patient | 小程序拉取/完成任务 |
| `/care/patient/summary` | GET | patient | 首页待办/未读徽标 |
| `/model/predict_fmri`、`/model/predict_mock` | POST | researcher/patient | .1D 真实推理 / 演示预测 |
| `/security/patient/{id}/overview` | GET | researcher | 报告页安全概览 |
