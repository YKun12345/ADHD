from __future__ import annotations

import csv
import io
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import Lasso


class HGSTPreprocessError(ValueError):
    pass


def _parse_numeric_tokens(line: str) -> list[float]:
    values: list[float] = []
    for token in line.strip().replace(",", " ").split():
        try:
            values.append(float(token))
        except ValueError:
            continue
    return values


def parse_timeseries_bytes(file_bytes: bytes, filename: str) -> np.ndarray:
    suffix = Path(filename or "").suffix.lower()
    if suffix == ".csv":
        frame = pd.read_csv(io.BytesIO(file_bytes), header=None)
        frame = frame.apply(pd.to_numeric, errors="coerce")
        frame = frame.dropna(axis=1, how="all").dropna(axis=0, how="all").dropna(axis=0, how="any")
        if frame.empty:
            raise HGSTPreprocessError("上传的 CSV 无法解析出有效的数值时间序列。")
        data = frame.to_numpy(dtype=float)
    else:
        text = file_bytes.decode("utf-8", errors="ignore")
        rows: list[list[float]] = []
        for line in text.splitlines():
            numeric_tokens = _parse_numeric_tokens(line)
            if len(numeric_tokens) >= 2:
                rows.append(numeric_tokens)
        if not rows:
            raise HGSTPreprocessError("上传的时间序列文件无法解析出有效数值。")
        common_length = max(set(map(len, rows)), key=lambda value: sum(1 for row in rows if len(row) == value))
        normalized_rows = [row[:common_length] for row in rows if len(row) >= common_length]
        data = np.asarray(normalized_rows, dtype=float)

    if data.ndim != 2:
        raise HGSTPreprocessError("时间序列必须是二维矩阵。")
    if min(data.shape) < 2:
        raise HGSTPreprocessError("时间序列维度过小，无法进行推理。")
    return data


def normalize_timeseries_shape(timeseries: np.ndarray) -> np.ndarray:
    matrix = np.asarray(timeseries, dtype=float)
    if matrix.ndim != 2:
        raise HGSTPreprocessError("时间序列矩阵维度不正确。")

    row_count, col_count = matrix.shape
    roi_candidates = {90, 116}

    if col_count in roi_candidates:
        oriented = matrix
    elif row_count in roi_candidates:
        oriented = matrix.T
    else:
        raise HGSTPreprocessError(
            f"当前时间序列的 ROI 维度为 {row_count}x{col_count}，仅支持 90 或 116 ROI 的时间序列。"
        )

    if oriented.shape[1] == 116:
        oriented = oriented[:, :90]
    elif oriented.shape[1] != 90:
        raise HGSTPreprocessError("归一化后 ROI 维度不是 90，无法继续推理。")

    if oriented.shape[0] < 10:
        raise HGSTPreprocessError("时间点数量过少，至少需要 10 个时间点。")

    return oriented


def subject_connectivity(timeseries: np.ndarray) -> np.ndarray:
    matrix = np.asarray(timeseries, dtype=float)
    centered = matrix - matrix.mean(axis=0, keepdims=True)
    std = matrix.std(axis=0, keepdims=True)
    std[std == 0] = 1.0
    normalized = centered / std
    connectivity = np.corrcoef(normalized.T)
    connectivity = np.nan_to_num(connectivity, nan=0.0, posinf=0.0, neginf=0.0)
    return connectivity.astype(np.float32)


def construct_hyperedges_from_time_series(time_series: np.ndarray, lambda_value: float = 0.2) -> list[list[int]]:
    signal_matrix = np.asarray(time_series, dtype=float).T
    num_regions, _ = signal_matrix.shape
    hyperedges: list[list[int]] = []

    for region_index in range(num_regions):
        target_series = signal_matrix[region_index]
        other_series = np.delete(signal_matrix, region_index, axis=0)
        lasso = Lasso(alpha=lambda_value, max_iter=5000, tol=1e-4)
        lasso.fit(other_series.T, target_series)

        non_zero_indices = np.where(lasso.coef_ != 0)[0]
        original_indices = [index if index < region_index else index + 1 for index in non_zero_indices]
        hyperedges.append([region_index] + original_indices)

    return hyperedges


def _find_column(frame: pd.DataFrame, candidates: list[str], description: str) -> str:
    for candidate in candidates:
        if candidate in frame.columns:
            return candidate
    raise HGSTPreprocessError(f"标签文件中找不到 {description}，预期字段之一为：{candidates}")


def _normalize_subject_id(value) -> str:
    text = str(value).strip()
    if text.endswith(".0"):
        text = text[:-2]
    digits_only = "".join(ch for ch in text if ch.isdigit())
    text = digits_only or text
    if text.isdigit() and len(text) < 7:
        text = text.zfill(7)
    return text


def _resolve_subject_dir(base_dir: Path, raw_id) -> tuple[Path, str]:
    normalized_id = _normalize_subject_id(raw_id)
    candidate_ids = []
    for candidate in (str(raw_id).strip(), normalized_id):
        if candidate and candidate not in candidate_ids:
            candidate_ids.append(candidate)

    for candidate in candidate_ids:
        subject_dir = base_dir / candidate
        if subject_dir.exists():
            return subject_dir, candidate

    raise HGSTPreprocessError(f"未在 {base_dir} 下找到受试者目录：{raw_id}")


def _find_timeseries_file(subject_dir: Path, subject_id: str) -> Path:
    exact_match = subject_dir / f"sfnwmrda{subject_id}_session_1_rest_1_aal_TCs.1D"
    if exact_match.exists():
        return exact_match

    patterns = [
        "*session_1_rest_1_aal_TCs*.1D",
        "*rest_1*aal_TCs*.1D",
        "*.1D",
    ]
    for pattern in patterns:
        matches = sorted(subject_dir.glob(pattern))
        if matches:
            return matches[0]

    raise HGSTPreprocessError(f"未在 {subject_dir} 下找到可用的 .1D 时间序列文件。")


def load_adhd_dataset(data_dir: str | Path, labels_path: str | Path) -> tuple[np.ndarray, list[np.ndarray], list[np.ndarray]]:
    data_root = Path(data_dir).expanduser().resolve()
    label_file = Path(labels_path).expanduser().resolve()
    if not data_root.exists():
        raise HGSTPreprocessError(f"HGST 数据目录不存在：{data_root}")
    if not label_file.exists():
        raise HGSTPreprocessError(f"HGST 标签文件不存在：{label_file}")

    label_frame = pd.read_csv(label_file)
    id_column = _find_column(label_frame, ["ID", "ScanDir ID", "ScanDirID"], "受试者 ID 列")
    label_column = _find_column(label_frame, ["DX", "Label", "label"], "诊断标签列")

    labels: list[int] = []
    features: list[np.ndarray] = []
    all_timeseries: list[np.ndarray] = []

    for _, row in label_frame.iterrows():
        subject_dir, subject_id = _resolve_subject_dir(data_root, row[id_column])
        file_path = _find_timeseries_file(subject_dir, subject_id)
        file_bytes = file_path.read_bytes()
        timeseries = normalize_timeseries_shape(parse_timeseries_bytes(file_bytes, file_path.name))
        all_timeseries.append(timeseries)
        features.append(subject_connectivity(timeseries))
        label = int(float(row[label_column]))
        labels.append(1 if label > 1 else label)

    return np.asarray(labels, dtype=np.int64), features, all_timeseries

