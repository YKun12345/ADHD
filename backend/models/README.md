# backend/models/ — HGST 部署模型目录

真实 HGST 时间序列分类模型的部署权重统一放在本目录。当前仓库**不随源码附带真实权重**：
默认演示走 Mock（见 `USE_MOCK_MODEL`），真实链路在放入下列权重文件后自动启用。

## 权重文件

| 文件 | 作用 |
|---|---|
| `hgst_adhd_bundle.pt` | 部署版推理 bundle（默认路径，可用环境变量 `HGST_DEPLOYMENT_BUNDLE_PATH` 覆盖） |

## bundle 契约（`torch.save` 出的 dict）

加载逻辑见 `backend/app/services/hgst_runtime/service.py::load_hgst_bundle` 与 `predict_timeseries_file`：

```python
bundle = {
    "config": {                     # num_nodes / in_dim / hid_dim / num_classes / encoder_type /
        ...                         # decoder_type / edge_lambda / label_mapping / model_name / model_version ...
    },
    "encoder_state_dict": {...},        # PreModel（超图自监督编码器）state_dict，CPU
    "classifier_state_dict": {...},     # MLPClassifier state_dict
    "classifier_input_dim": int,        # 分类头输入维
    "val_accuracy" 或 "train_accuracy_full": float,   # 复现用指标
}
```

推理全程 CPU（`torch.load(..., map_location="cpu")`），输入为 AAL90/116 的 `.1D`/`.csv`
时间序列；预处理见 `hgst_runtime/preprocessing.py`（ROI=116 会自动截断为 90）。

## 如何生成

1. 在 **Python<=3.10** 环境安装 `requirements-hgst.txt`（`torch==1.13.1`、`dhg==0.9.5` 等）。
2. 用 `HGST-main/` 预训练脚本产出 encoder 权重（对应 `HGST_PRETRAINED_WEIGHTS_PATH`），
   或在 `HGST-main/logs/ADHD/.../pretrained_model_*.pth` 中使用已有预训练产物。
3. 在本项目生成部署 bundle：

```bash
python -m backend.scripts.build_hgst_bundle \
  --data-dir <AAL 时间序列数据目录> \
  --labels-path <标签.csv> \
  --pretrained <预训练 .pth> \
  --output backend/models/hgst_adhd_bundle.pt
```

4. 校验：

```bash
USE_MOCK_MODEL=false python scripts/verify_model.py
# 应输出 “真实 HGST 推理” 且 source_type 非 mock
```

## 提示

- 真实推理需依赖与权重都齐备；缺任一默认走 503（`real` 模式，不静默降级）。
- 答辩/演示无需真实权重：设 `USE_MOCK_MODEL=true`（恒 Mock）或 `auto`（缺失时降级），
  输出均带 `is_demo=true` 与“不可用于诊断”免责。
- `.gitignore` 已忽略 `*.pt`，真实权重不会误入版本库。
