# 真实 HGST 模型集成方案（Mock / real / auto 推理模式）

> 状态：已实现并单测通过（15 passed）。本文件说明“5 项交付物”分别落在哪些代码、行为语义、
> 如何验证、答辩口径与回滚。
>
> 背景：分工文档要求“模拟预测（真上传、假结果）”；答辩用 Mock 即可，但需要在 PPT 中如实说明。

## 1. 交付物 → 落地位置

| # | 请求的交付物 | 落地代码 / 文件 | 说明 |
|---|---|---|---|
| 1 | 模型加载模块（.pt 加载、CPU 推理） | `backend/app/services/hgst_runtime/service.py::load_hgst_bundle`、`predict_timeseries_file` | `torch.load(..., map_location="cpu")`；解析 `hgst_adhd_bundle.pt` 契约（config / encoder_state_dict / classifier_state_dict / classifier_input_dim）。预训练/打包链路：`build_hgst_deployment_bundle`、`backend/scripts/build_hgst_bundle.py` |
| 2 | 推理接口（.1D → ADHD/Control + 概率） | `backend/app/api/routes/model_inference.py::predict_fmri`；服务入口 `service.predict_with_mode` | 上传 `.1D`/`.csv`（multipart `timeseries_file`）→ 持久化上传 → 推理 → 返回 label + ADHD/Control 概率 + `is_demo` |
| 3 | Mock/真实模式切换 + 不可用时自动降级 + 日志标识 | `config.USE_MOCK_MODEL`；`service.resolve_inference_mode` / `predict_with_mode` / `describe_model_mode`；`main.py` 启动日志 | 模式表见 §2；模式转换全部写日志（§4） |
| 4 | 模型加载验证脚本 | `scripts/verify_model.py`（薄壳）→ `backend/scripts/verify_model.py` | `python scripts/verify_model.py`，退出码 0/1/2，见 §5 |
| 5 | 模型文件说明 | `backend/models/README.md`；权重放 `backend/models/hgst_adhd_bundle.pt` | 目录被 `.gitignore` 忽略，真实权重不入库 |

## 2. 推理模式语义

环境变量 `USE_MOCK_MODEL`（`backend/app/core/config.py` → `settings.USE_MOCK_MODEL`），逐次推理前解析：

| 取值 | 模式 | predict_fmri 行为 | 响应标识 | 适用 |
|---|---|---|---|---|
| 留空 / `false` / `0` / `no` / `off` / `real` / `strict` | **real（默认）** | 真实 HGST；缺 torch/dhg 依赖或权重 → **503，绝不静默降级** | `source_type=fmri_hgst`、`is_demo=false`、免责 “Screening support only” | 生产/验收（安全护栏，有 guardrail 测试） |
| `true` / `1` / `yes` / `on` / `mock` | **mock** | 恒走演示 Mock：**真上传、假结果**（沿用真实解析规则校验 ROI/时间点，内容哈希定概率 0.6–0.9） | `source_type=mock`、`is_demo=true`、免责 “Demonstration output only…” | 答辩 / 联调 UI，无需真实权重 |
| `auto` | **auto** | 真实优先；HGST 不可用（缺依赖/权重）时自动降级为带标识 Mock 并打**告警日志** | 成功时同上 real 口径；降级时 `is_demo=true` | 需要“能出结果又诚实标注”的演示环境 |

未知取值：打 warning 后按 real 处理（宁可 503，不静默伪造）。

> 关键取舍：原实现有一条硬性不变式“真实推理失败绝不静默降级成 Mock”（验收 D6 + 测试
> `test_real_inference_failure_does_not_fall_back_to_mock`）。集成后该不变式保留为**默认 real 模式**；
> “自动降级”只发生在用户显式设 `USE_MOCK_MODEL=auto` 时，且结果带 `is_demo=true`，不会把假结果
> 伪装成真实诊断。

## 3. 端到端数据流

```
.1D / .csv 上传
   → routes/model_inference.predict_fmri（读字节、校验、store 上传行）
   → services/hgst_runtime/service.predict_with_mode(bytes, file_name)   ← 唯一的模式决策点
        ├─ mock → _demo_result_for_timeseries()        source_type="mock"
        ├─ real → predict_timeseries_file()            source_type="timeseries_hgst"
        └─ auto → 尝试 real；不可用则降级 mock（warning log）
   → 写 ModelPrediction（DB source_type = "mock" 或 "fmri_hgst"）
   → 返回 TimeseriesPredictionResponse（prediction_label, probability, probability_control,
                                          is_demo, disclaimer, model_name/version, ...）
```

演示结果确定性与说明：`sha256(文件字节)` 定概率（0.60–0.90 内），ROI/时间点数取自真实解析
（AAL90/116，ROI=116 自动截断为 90）。无效内容（非数值、列数/时间点不合格）在 mock 模式同样抛
`HGSTInferenceError` → HTTP 422，**不把坏文件包装成“成功”**。

## 4. 日志标识（如何确认当前在哪个模式）

- 启动：`main.py` lifespan 用 `uvicorn.error` logger 打印
  `Model inference mode: USE_MOCK_MODEL='...' -> real|mock|auto`
- 每次推理：`predict_with_mode` 打 `info`，如 `推理模式 real：HGST 真实推理完成（...）`；
  强制 mock 打 `USE_MOCK_MODEL=true：predict_fmri 走演示 Mock（真上传假结果）…`
- auto 降级：打 `warning`，如
  `真实 HGST 不可用（HGSTUnavailableError）：… 已按 USE_MOCK_MODEL=auto 自动降级为演示 Mock…`

调用方也可凭响应字段判别：`is_demo=true` 即演示，`disclaimer` 提示“不可用于诊断”。

## 5. 验证

```bash
# 仓库根，默认 real 模式（缺 torch/dhg 或权重 → exit 2 并说明原因）
python scripts/verify_model.py

# 显式覆盖为 mock：合成 90×16 .1D 端到端推理，is_demo=true
python scripts/verify_model.py --mode mock        # exit 0

# 等价模块式
python -m backend.scripts.verify_model
```

退出码：0 当前配置链路可用（含 auto/mock 明确演示结果）；1 未预期错误；2 默认真实模式下
torch/dhg 依赖或权重文件缺失。本机实测：real → 2（依赖缺失并提示安装要求/演示开关），
mock → 0（`label=ADHD`、概率 0.6630、`is_demo=True`、`DemoMock/mock-2026-08`、`90×16`）。

自动测试：

```bash
python -m pytest backend/tests/test_model_modes.py backend/tests/test_model_upload.py -q
# 15 passed
```

覆盖：模式解析（默认/real token、mock token、auto）、强制 mock、auto 降级、**real 不降级**、
mock 下坏输入报错、bundle 默认路径在 `backend/models/` 下、上传路由回归
（含 `test_real_inference_failure_does_not_fall_back_to_mock` guardrail）。

## 6. 启用真实模型（仅需时执行）

> 本机是 Python 3.11；`requirements-hgst.txt` 固定 `torch==1.13.1` / `dhg==0.9.5`，
> **需要 Python≤3.10**。因此当前环境无法安装真实运行时，默认保持 real→503 或显式 mock/auto 演示。

1. 建 Python≤3.10 环境并按 `requirements-hgst.txt` 安装依赖。
2. 准备 encoder 预训练权重（`HGST_PRETRAINED_WEIGHTS_PATH`，缺省为
   `HGST-main/logs/ADHD/sparse_2026-04-01-11-41-03/pretrained_model_2020.pth`）。
3. 生成部署 bundle 到 `backend/models/hgst_adhd_bundle.pt`：

   ```bash
   python -m backend.scripts.build_hgst_bundle \
     --data-dir <AAL 时间序列目录> --labels-path <标签.csv> \
     --pretrained <预训练 .pth> --output backend/models/hgst_adhd_bundle.pt
   ```

4. 校验：

   ```bash
   USE_MOCK_MODEL=false python scripts/verify_model.py   # 应显示真实推理、source_type 非 mock
   ```

路径空值防护：`config.py` 对 `HGST_*` 路径统一 `os.getenv(..) or 默认值` —— 即使 `.env` 里写了
`HGST_DEPLOYMENT_BUNDLE_PATH=`（空），也会回退到 `backend/models/hgst_adhd_bundle.pt`，不会把
路径解析成空串。详见 `backend/models/README.md`。

## 7. 演示与答辩口径

- 当前演示/联调链路是 **Mock（`USE_MOCK_MODEL=true` 或 `auto`）**：输出带 `is_demo=true` +
  “Demonstration output only; not a medical diagnosis.”，PPT 需如实说明“模拟预测（真上传假结果）”，
  不构成诊断或临床有效性的证据。
- 默认 real 模式在缺权重/依赖时返回 503，是为防止把演示结果冒充真实诊断的安全设计，属**预期行为**；
  答辩若被问到“为什么上传报错”，对应回答：真实 HGST 需 Python≤3.10 + torch/dhg + 权重，演示环境
  用 `USE_MOCK_MODEL=true/auto` 而非关掉安全边界。
- 真实推理与 Mock 共用同一路由与响应结构（`upload_id`、`probability_control`、`model_name` 等），
  切换模式只改环境变量，无需改前端。

## 8. 回滚

- 模式相关行为只由环境变量驱动：去掉 `USE_MOCK_MODEL`（或设回空）即回到默认 real 严格模式；
  不需要代码回滚。
- 若需回退“config 默认路径指向 backend/models”这一改动，回到 `HGST_DEPLOYMENT_BUNDLE_PATH` 原默认并
  还原 `HGST_PRETRAINED_WEIGHTS_PATH` 内联默认即可；但建议保留空值回退防护（`or 默认`），否则
  `.env` 里空值仍会清空真实路径。
- `.env.example` 已去掉“空 HGST 路径”这个坑的误导写法并新增 `USE_MOCK_MODEL=` 说明；
  复制新 `.env.example` 不会破坏现有 `.env`。

## 相关文档

- `backend/models/README.md` — 模型目录 / bundle 契约 / 生成与校验
- `backend/app/services/hgst_runtime/preprocessing.py` — .1D 解析、ROI 归一、连接矩阵、超图构造
- `docs/evidence/api-contract.md`、`docs/evidence/doctor-web-acceptance-checklist-2026-09-03.md` — 接口契约与验收口径
- 根 `README.md` §7、`backend/README.md` §模型接口 — 模式边界速览
