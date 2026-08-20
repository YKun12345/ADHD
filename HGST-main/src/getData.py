import os
from pathlib import Path

import numpy as np
import pandas as pd
import scipy
from sklearn.linear_model import Lasso
from sklearn.preprocessing import MinMaxScaler, StandardScaler

from .corr import subject_connectivity

REPO_ROOT = Path(__file__).resolve().parent.parent


def _resolve_input_path(env_name: str, default_path: Path, description: str) -> Path:
    raw_path = os.environ.get(env_name)
    path = Path(raw_path).expanduser() if raw_path else default_path
    if not path.is_absolute():
        path = (REPO_ROOT / path).resolve()
    if not path.exists():
        raise FileNotFoundError(
            f"{description} not found: {path}. Set the {env_name} environment variable to the correct path."
        )
    return path


def _find_column(frame: pd.DataFrame, candidates, description: str) -> str:
    for candidate in candidates:
        if candidate in frame.columns:
            return candidate
    raise KeyError(f"Could not find {description}. Expected one of: {candidates}")


def _normalize_subject_id(value) -> str:
    text = str(value).strip()
    if text.endswith(".0"):
        text = text[:-2]
    digits_only = "".join(ch for ch in text if ch.isdigit())
    text = digits_only or text
    if text.isdigit() and len(text) < 7:
        text = text.zfill(7)
    return text


def _resolve_adhd_subject_dir(base_dir: Path, raw_id):
    normalized_id = _normalize_subject_id(raw_id)
    candidate_ids = []
    for candidate in (str(raw_id).strip(), normalized_id):
        if candidate and candidate not in candidate_ids:
            candidate_ids.append(candidate)

    for candidate in candidate_ids:
        subject_dir = base_dir / candidate
        if subject_dir.exists():
            return subject_dir, candidate

    raise FileNotFoundError(f"Could not find an ADHD subject folder for ID {raw_id} under {base_dir}")


def _find_adhd_timeseries_file(subject_dir: Path, subject_id: str) -> Path:
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

    raise FileNotFoundError(f"Could not find a .1D time series file under {subject_dir}")


def _load_adhd_timeseries(file_path: Path) -> np.ndarray:
    df = pd.read_csv(file_path, sep=r"\s+", header=None, engine="python")
    numeric_df = df.apply(pd.to_numeric, errors="coerce")
    numeric_df = numeric_df.dropna(axis=1, how="all").dropna(axis=0, how="all")
    numeric_df = numeric_df.dropna(axis=0, how="any")

    if numeric_df.empty:
        raise ValueError(f"Could not parse numeric ADHD time series from {file_path}")

    timeseries = numeric_df.to_numpy(dtype=float)
    if timeseries.shape[1] > 100 and timeseries.shape[1] - 2 in (90, 116):
        timeseries = timeseries[:, 2:]

    return timeseries


def get_data_adhd():
    labels, all_data, all_timeseries = [], [], []
    excel_dir = _resolve_input_path(
        "HGST_ADHD_LABELS",
        REPO_ROOT / "data" / "ADHD" / "ADHD_labels.csv",
        "ADHD label file",
    )
    excel = pd.read_csv(excel_dir)
    id_column = _find_column(excel, ["ID", "ScanDir ID", "ScanDirID"], "an ADHD subject ID column")
    label_column = _find_column(excel, ["DX", "Label", "label"], "an ADHD diagnosis label column")
    ids = excel[id_column].tolist()
    base_dir = _resolve_input_path(
        "HGST_ADHD_DIR",
        REPO_ROOT / "data" / "ADHD" / "ADHD_all",
        "ADHD data directory",
    )

    for i, raw_id in enumerate(ids):
        subject_dir, subject_id = _resolve_adhd_subject_dir(base_dir, raw_id)
        file_path = _find_adhd_timeseries_file(subject_dir, subject_id)
        timeseries = _load_adhd_timeseries(file_path)
        all_timeseries.append(timeseries)
        all_data.append(subject_connectivity(timeseries, "correlation"))
        label = int(excel[label_column].iloc[i])
        if label > 1:
            label = 1
        labels.append(label)

    return np.array(labels), np.array(all_data), all_timeseries


def get_data_mdd():
    labels, data, all_timeseries = [], [], []

    folder_path = _resolve_input_path(
        "HGST_MDD_DIR",
        REPO_ROOT / "data" / "MDD" / "ROISignals_FunImgARCWF",
        "MDD ROI signal directory",
    )
    excel_dir = _resolve_input_path(
        "HGST_MDD_LABELS",
        REPO_ROOT / "data" / "MDD" / "REST-meta-MDD-PhenotypicData_WithHAMDSubItem_V4.csv",
        "MDD label file",
    )
    excel = pd.read_csv(excel_dir)
    id_column = _find_column(excel, ["ID", "Id", "id"], "an MDD subject ID column")
    positive_ids = set(excel[id_column].astype(str))

    for filename in sorted(os.listdir(folder_path)):
        if filename.endswith(".mat"):
            file_path = os.path.join(folder_path, filename)
            mat = scipy.io.loadmat(file_path)
            t = mat["ROISignals"][:, :90]
            all_timeseries.append(t)
            data.append(subject_connectivity(t, "correlation"))

            pos_num = filename.split("_")[1].split(".")[0]
            label = 1 if pos_num in positive_ids else 0
            labels.append(label)

    return np.array(labels), np.array(data), all_timeseries


def construct_hyperedges_from_time_series(time_series: np.ndarray, lambda_value: float, scaler=None):
    """
    Construct hyperedges via sparse representation.

    Args:
        time_series (np.ndarray): Time series with shape (num_timepoints, num_regions).
        lambda_value (float): L1 regularization parameter used to control sparsity.
        scaler: Optional scaler name, either "standard" or "minmax".

    Returns:
        list[list[int]]: Hyperedges formatted for dhg.Hypergraph.add_hyperedges.
    """
    time_series = time_series.T

    num_regions, _ = time_series.shape
    hyperedges = []

    if scaler is not None:
        if scaler.lower() == "standard":
            bold_scaler = StandardScaler()
        elif scaler.lower() == "minmax":
            bold_scaler = MinMaxScaler()
        else:
            raise ValueError(f"Unsupported scaler: {scaler}")
        time_series = bold_scaler.fit_transform(time_series.T).T

    for m in range(num_regions):
        target_series = time_series[m]
        other_series = np.delete(time_series, m, axis=0)
        lasso = Lasso(alpha=lambda_value, max_iter=5000, tol=1e-4)
        lasso.fit(other_series.T, target_series)

        non_zero_indices = np.where(lasso.coef_ != 0)[0]
        original_indices = [i if i < m else i + 1 for i in non_zero_indices]
        hyperedge = [m] + original_indices
        hyperedges.append(hyperedge)

    return hyperedges
