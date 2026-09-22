# backend/models/ — HGST 部署模型目录

真实 HGST 时间序列分类模型的部署权重统一放在本目录。Git 仓库**不随源码附带真实权重**；
本地放入下列权重文件后，后端可以发现部署 bundle，但真实推理仍要求兼容的 Python、PyTorch
和 DHG 运行环境。推理模式及演示标识由 `USE_MOCK_MODEL` 控制。

## 权重文件

| 文件 | 作用 |
|---|---|
| `hgst_adhd_bundle.pt` | 部署版推理 bundle（默认路径，可用环境变量 `HGST_DEPLOYMENT_BUNDLE_PATH` 覆盖） |

## 本地迁移记录

2026-09-21 从相邻旧源码工作区的 `backend/artifacts/hgst_adhd_bundle.pt` 安全迁移到本目录：

- 文件大小：`59,203,363` 字节
- SHA-256：`74575AFA48EF423461CA463F8C57CC2F1B767C3CF320C94367C00E02ABA7F95A`
- 只读结构检查：包含 `encoder_state_dict`、`classifier_state_dict`、`classifier_input_dim`
- Git 状态：继续由 `*.pt` 规则忽略，仅作为本机部署资产保存

这条记录只证明文件身份和结构标识正确，不表示当前电脑已经具备真实推理依赖，也不代表模型
准确率已经重新验证。部署到其他电脑时，需要单独安全传输权重并再次核对上述 SHA-256。

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
