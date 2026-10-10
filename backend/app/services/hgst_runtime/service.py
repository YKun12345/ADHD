from __future__ import annotations

import hashlib
import importlib
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.metrics import accuracy_score

from backend.app.core.config import settings
from backend.app.services.hgst_runtime.evaluation import (
    ValidationCheckpoint,
    classification_metrics,
    snapshot_state_dict,
    stratified_partitions,
)
from backend.app.services.hgst_runtime.preprocessing import (
    HGSTPreprocessError,
    construct_hyperedges_from_time_series,
    load_adhd_dataset,
    normalize_timeseries_shape,
    parse_timeseries_bytes,
    subject_connectivity,
)

logger = logging.getLogger("backend.hgst_runtime")

# 模型/演示标识口径：source_type == "mock" 的记录即为演示（is_demo=true）。
MOCK_SOURCE_TYPE = "mock"


class HGSTUnavailableError(RuntimeError):
    pass


class HGSTBundleMissingError(RuntimeError):
    pass


class HGSTInferenceError(RuntimeError):
    pass


@dataclass
class HGSTPredictionResult:
    prediction_label: str
    probability: float
    probability_control: float
    roi_dim_used: int
    timepoints: int
    file_name: str
    model_name: str
    model_version: str
    source_type: str
    summary_text: str


def resolve_inference_mode() -> str:
    """解析推理模式，返回 'mock' | 'real' | 'auto'。

    - ``mock``（USE_MOCK_MODEL=true/1/yes/on/mock）  ：恒走演示 Mock（真上传假结果）。
    - ``real``（未设置，或 false/0/no/off/real/strict）：真实 HGST；缺依赖/权重时抛错（默认，安全护栏）。
    - ``auto``（USE_MOCK_MODEL=auto）                 ：真实优先，HGST 不可用时降级为带标识 Mock。
    """
    raw = (settings.USE_MOCK_MODEL or "").strip().lower()
    if raw in {"true", "1", "yes", "on", "mock"}:
        return "mock"
    if raw == "auto":
        return "auto"
    if raw and raw not in {"false", "0", "no", "off", "real", "strict"}:
        logger.warning("无法识别的 USE_MOCK_MODEL=%r，按默认真实模式处理（缺失依赖/权重时返回错误，不静默降级）。", settings.USE_MOCK_MODEL)
    return "real"


def describe_model_mode() -> str:
    """返回便于写入日志/页面的当前模式描述。"""
    raw = settings.USE_MOCK_MODEL or "(未设置)"
    return f"USE_MOCK_MODEL={raw!r} -> {resolve_inference_mode()}"


def _demo_result_for_timeseries(file_bytes: bytes, file_name: str) -> HGSTPredictionResult:
    """生成确定性演示结果（真上传、假结果）：沿用真实 .1D 的 ROI/时间点数，概率由文件内容哈希决定。

    - 先按真实推理同样的规则校验/解析输入（ROI 90/116、>=10 时间点），解析失败抛 HGSTInferenceError（路由返回 422），
      避免把无效文件伪装成"成功推理"。
    - source_type 恒为 'mock'，供上层写入 DB/响应时标记 is_demo=true 与演示免责声明。
    """
    try:
        timeseries = normalize_timeseries_shape(parse_timeseries_bytes(file_bytes, file_name))
    except HGSTPreprocessError as exc:
        raise HGSTInferenceError(str(exc)) from exc

    roi_dim_used = int(timeseries.shape[1])
    timepoints = int(timeseries.shape[0])

    digest = hashlib.sha256(file_bytes).hexdigest()
    probability = round(0.65 + (int(digest[:8], 16) % 100) / 1000, 3)
    probability = round(min(max(probability, 0.6), 0.9), 3)
    probability_control = round(1 - probability, 3)
    label = "ADHD" if probability >= 0.5 else "Control"

    return HGSTPredictionResult(
        prediction_label=label,
        probability=probability,
        probability_control=probability_control,
        roi_dim_used=roi_dim_used,
        timepoints=timepoints,
        file_name=file_name,
        model_name="DemoMock",
        model_version="mock-2026-08",
        source_type=MOCK_SOURCE_TYPE,
        summary_text=(
            f"演示/模拟预测（真上传、假结果）：label {label}，ADHD 概率 {probability:.2%}。"
            "该结果由上传文件内容确定性生成，仅供集成演示与界面联调，不构成医学诊断。"
        ),
    )


def predict_with_mode(file_bytes: bytes, file_name: str) -> HGSTPredictionResult:
    """模式感知的推理入口（真实 / 自动降级 / 演示 Mock）。

    路由层调用本函数；真实结果 source_type 非 mock，演示结果 source_type == 'mock'，
    上层据此写入 DB 并返回 is_demo 与相应免责声明。模式转换全部写日志。
    """
    mode = resolve_inference_mode()
    logger.info("fMRI 推理模式：%s", describe_model_mode())

    if mode == "mock":
        logger.info("USE_MOCK_MODEL=true：predict_fmri 走演示 Mock（真上传假结果），结果 is_demo=true，不调用真实 HGST。")
        return _demo_result_for_timeseries(file_bytes, file_name)

    try:
        result = predict_timeseries_file(file_bytes, file_name)
    except HGSTPreprocessError as exc:
        # 真实路径里解析/形状校验失败统一映射为 422（原实现可能冒泡成 500）。
        raise HGSTInferenceError(str(exc)) from exc
    except (HGSTUnavailableError, HGSTBundleMissingError) as exc:
        if mode == "auto":
            logger.warning(
                "真实 HGST 不可用（%s）：%s。已按 USE_MOCK_MODEL=auto 自动降级为演示 Mock（is_demo=true，不构成诊断）。",
                exc.__class__.__name__,
                exc,
            )
            return _demo_result_for_timeseries(file_bytes, file_name)
        logger.info("推理模式 real：HGST 不可用且未开启降级（USE_MOCK_MODEL=%r），不静默降级，向上抛错。", settings.USE_MOCK_MODEL)
        raise

    logger.info("推理模式 real：HGST 真实推理完成（%s/%s）。", result.model_name, result.model_version)
    return result


def _import_runtime_dependencies():
    try:
        torch = importlib.import_module("torch")
        Hypergraph = importlib.import_module("dhg").Hypergraph
    except ModuleNotFoundError as exc:
        raise HGSTUnavailableError(
            "HGST 推理依赖尚未安装。当前至少需要 torch 和 dhg 才能进行时间序列分类。"
        ) from exc

    from backend.app.services.hgst_runtime.modeling import MLPClassifier, PreModel

    return torch, Hypergraph, PreModel, MLPClassifier


def _default_bundle_config() -> dict[str, Any]:
    return {
        "num_nodes": 90,
        "in_dim": 90,
        "hid_dim": 512,
        "num_classes": 2,
        "encoder_type": "hgnnp",
        "decoder_type": "hgnnp",
        "use_bn": True,
        "dropout": 0.0,
        "mask_rate": 0.5,
        "replace_rate": 0.05,
        "loss_fn": "sce",
        "edge_lambda": 0.2,
        "connectivity_kind": "correlation",
        "label_mapping": {0: "Control", 1: "ADHD"},
        "model_name": "HGST_ADHD_timeseries",
        "model_version": "2026-04-01",
    }


def _bundle_path() -> Path:
    return Path(settings.HGST_DEPLOYMENT_BUNDLE_PATH).expanduser().resolve()


def _pretrained_path() -> Path:
    return Path(settings.HGST_PRETRAINED_WEIGHTS_PATH).expanduser().resolve()


def load_hgst_bundle(bundle_path: str | Path | None = None) -> dict[str, Any]:
    torch, _, _, _ = _import_runtime_dependencies()
    path = Path(bundle_path).expanduser().resolve() if bundle_path else _bundle_path()
    if not path.exists():
        raise HGSTBundleMissingError(
            f"尚未找到 HGST 部署版推理权重：{path}。请先在当前项目中生成 deployment bundle。"
        )
    bundle = torch.load(path, map_location="cpu")
    if not isinstance(bundle, dict) or "encoder_state_dict" not in bundle or "classifier_state_dict" not in bundle:
        raise HGSTInferenceError("HGST 部署版推理权重格式不正确。")
    return bundle


def build_hgst_deployment_bundle(
    data_dir: str | Path,
    labels_path: str | Path,
    output_path: str | Path | None = None,
    pretrained_weights_path: str | Path | None = None,
    seed: int = 2020,
    max_epoch_f: int = 250,
    lr_f: float = 0.001,
    weight_decay_f: float = 1e-4,
    train_on_full_dataset: bool = False,
) -> Path:
    if max_epoch_f < 1:
        raise ValueError("Classifier training needs at least one epoch")
    torch, Hypergraph, PreModel, MLPClassifier = _import_runtime_dependencies()
    torch.manual_seed(seed)
    np.random.seed(seed)

    labels, features, timeseries_all = load_adhd_dataset(data_dir, labels_path)
    config = _default_bundle_config()
    pretrained_path = Path(pretrained_weights_path).expanduser().resolve() if pretrained_weights_path else _pretrained_path()
    if not pretrained_path.exists():
        raise HGSTBundleMissingError(f"预训练权重不存在：{pretrained_path}")

    num_nodes = config["num_nodes"]
    model = PreModel(
        in_dim=config["in_dim"],
        hid_dim=config["hid_dim"],
        edge_dim=num_nodes,
        feat_drop=config["dropout"],
        use_bn=config["use_bn"],
        mask_rate=config["mask_rate"],
        encoder_type=config["encoder_type"],
        decoder_type=config["decoder_type"],
        loss_fn=config["loss_fn"],
        replace_rate=config["replace_rate"],
    )
    encoder_state = torch.load(pretrained_path, map_location="cpu")
    model.load_state_dict(encoder_state, strict=True)
    model.eval()

    embeddings = []
    for feature, timeseries in zip(features, timeseries_all):
        x = torch.tensor(feature, dtype=torch.float32)
        hyperedges = construct_hyperedges_from_time_series(timeseries, lambda_value=config["edge_lambda"])
        hg = Hypergraph(num_nodes, hyperedges)
        with torch.no_grad():
            graph_emb = model.embed(x, hg).reshape(-1)
        embeddings.append(graph_emb)

    all_embeddings = torch.stack(embeddings, dim=0)
    classifier = MLPClassifier(all_embeddings.shape[1], config["num_classes"])
    optimizer = torch.optim.Adam(classifier.parameters(), lr=lr_f, weight_decay=weight_decay_f)

    label_tensor = torch.tensor(labels, dtype=torch.long)

    # The supplied encoder may have seen this dataset. Its provenance is never inferred from a filename.
    logger.warning("Building bundle with external encoder of unverified provenance; holdout metrics describe the classifier only")
    if train_on_full_dataset:
        full_index = torch.arange(len(labels), dtype=torch.long)
        last_train_acc = 0.0
        for _ in range(max_epoch_f):
            classifier.train()
            logits = classifier(all_embeddings[full_index], None)
            loss = torch.nn.functional.cross_entropy(logits, label_tensor[full_index])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            classifier.eval()
            with torch.no_grad():
                train_logits = classifier(all_embeddings[full_index], None)
                train_pred = train_logits.argmax(dim=1).cpu().numpy()
                train_true = label_tensor[full_index].cpu().numpy()
                last_train_acc = float(accuracy_score(train_true, train_pred))
        best_state = snapshot_state_dict(classifier.state_dict())
        recorded_metrics = {"train_accuracy_full": last_train_acc}
        sample_counts = {"train": len(labels), "validation": 0, "test": 0}
    else:
        train_indices, validation_indices, test_indices = stratified_partitions(labels, seed=seed)
        train_index = torch.tensor(train_indices, dtype=torch.long)
        val_index = torch.tensor(validation_indices, dtype=torch.long)
        test_index = torch.tensor(test_indices, dtype=torch.long)
        selection = ValidationCheckpoint()
        for epoch in range(max_epoch_f):
            classifier.train()
            logits = classifier(all_embeddings[train_index], None)
            loss = torch.nn.functional.cross_entropy(logits, label_tensor[train_index])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            classifier.eval()
            with torch.no_grad():
                val_logits = classifier(all_embeddings[val_index], None)
                val_probabilities = torch.softmax(val_logits, dim=1).cpu().numpy()
                val_true = label_tensor[val_index].cpu().numpy()
            validation_metrics = classification_metrics(val_true, val_probabilities)
            selection.consider(epoch, validation_metrics, lambda: snapshot_state_dict(classifier.state_dict()))

        def evaluate_test():
            classifier.eval()
            with torch.no_grad():
                test_logits = classifier(all_embeddings[test_index], None)
                probabilities = torch.softmax(test_logits, dim=1).cpu().numpy()
            return classification_metrics(label_tensor[test_index].cpu().numpy(), probabilities)

        selected_metrics = selection.evaluate_test(classifier.load_state_dict, evaluate_test)
        best_state = selection.state
        recorded_metrics = {
            "val_accuracy": selected_metrics["val_acc"],
            "best_val_epoch": selected_metrics["best_val_epoch"],
            **{
                "test_" + ("accuracy" if key == "acc" else key) + "_classifier_holdout": selected_metrics["test_" + key]
                for key in ("acc", "recall", "precision", "f1", "auc", "specificity")
            },
        }
        sample_counts = {"train": len(train_indices), "validation": len(validation_indices), "test": len(test_indices)}

    bundle = {
        "config": {
            **config,
            "training_scope": "full_dataset" if train_on_full_dataset else "train_val_test_split",
            "pretraining_scope": "external_unverified",
            "evaluation_scope": "training_only" if train_on_full_dataset else "classifier_holdout_external_encoder",
            "end_to_end_test_verified": False,
            "selection_metric": None if train_on_full_dataset else "validation_accuracy",
            "tie_break": None if train_on_full_dataset else "earliest_epoch",
            "split_seed": seed,
            "sample_counts": sample_counts,
        },
        "encoder_state_dict": snapshot_state_dict(model.state_dict()),
        "classifier_state_dict": best_state,
        "classifier_input_dim": int(all_embeddings.shape[1]),
        **recorded_metrics,
    }

    target_path = Path(output_path).expanduser().resolve() if output_path else _bundle_path()
    target_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(bundle, target_path)
    return target_path


def predict_timeseries_file(file_bytes: bytes, file_name: str) -> HGSTPredictionResult:
    torch, Hypergraph, PreModel, MLPClassifier = _import_runtime_dependencies()

    bundle = load_hgst_bundle()
    config = {**_default_bundle_config(), **(bundle.get("config") or {})}

    timeseries = normalize_timeseries_shape(parse_timeseries_bytes(file_bytes, file_name))
    connectivity = subject_connectivity(timeseries)
    hyperedges = construct_hyperedges_from_time_series(timeseries, lambda_value=float(config["edge_lambda"]))

    model = PreModel(
        in_dim=int(config["in_dim"]),
        hid_dim=int(config["hid_dim"]),
        edge_dim=int(config["num_nodes"]),
        feat_drop=float(config["dropout"]),
        use_bn=bool(config["use_bn"]),
        mask_rate=float(config["mask_rate"]),
        encoder_type=str(config["encoder_type"]),
        decoder_type=str(config["decoder_type"]),
        loss_fn=str(config["loss_fn"]),
        replace_rate=float(config["replace_rate"]),
    )
    model.load_state_dict(bundle["encoder_state_dict"], strict=True)
    model.eval()

    classifier = MLPClassifier(int(bundle["classifier_input_dim"]), int(config["num_classes"]))
    classifier.load_state_dict(bundle["classifier_state_dict"], strict=True)
    classifier.eval()

    x = torch.tensor(connectivity, dtype=torch.float32)
    hg = Hypergraph(int(config["num_nodes"]), hyperedges)

    with torch.no_grad():
        graph_embedding = model.embed(x, hg).reshape(1, -1)
        logits = classifier(graph_embedding, None)
        probabilities = torch.softmax(logits, dim=1).cpu().numpy()[0]

    label_index = int(np.argmax(probabilities))
    label_mapping = config.get("label_mapping", {0: "Control", 1: "ADHD"})
    prediction_label = label_mapping.get(label_index, str(label_index))
    adhd_probability = float(probabilities[1]) if len(probabilities) > 1 else float(probabilities[0])
    control_probability = float(probabilities[0]) if len(probabilities) > 1 else float(1 - adhd_probability)

    risk_text = "较高" if adhd_probability >= 0.7 else "中等" if adhd_probability >= 0.4 else "较低"
    summary_text = (
        f"当前时间序列推理结果提示 ADHD 风险{risk_text}。"
        f"模型输出 ADHD 概率约为 {adhd_probability:.2%}，建议结合量表与认知测试继续综合判断。"
    )

    return HGSTPredictionResult(
        prediction_label=str(prediction_label),
        probability=adhd_probability,
        probability_control=control_probability,
        roi_dim_used=int(timeseries.shape[1]),
        timepoints=int(timeseries.shape[0]),
        file_name=file_name,
        model_name=str(config["model_name"]),
        model_version=str(config["model_version"]),
        source_type="timeseries_hgst",
        summary_text=summary_text,
    )
