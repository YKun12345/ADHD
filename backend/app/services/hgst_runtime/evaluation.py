"""Independent evaluation helpers; importing this module needs no torch or dhg."""
from __future__ import annotations

from typing import Any, Callable, Mapping, Sequence

import numpy as np
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import StratifiedShuffleSplit


def _indices(values, n_samples: int) -> np.ndarray:
    indices = np.asarray(values)
    if indices.ndim != 1 or not np.issubdtype(indices.dtype, np.integer):
        raise ValueError("Partition indices must be a one-dimensional integer array")
    if len(indices) == 0 or len(np.unique(indices)) != len(indices):
        raise ValueError("Partitions must be nonempty and contain no duplicate indices")
    if np.any(indices < 0) or np.any(indices >= n_samples):
        raise ValueError("Partition indices are outside the dataset")
    return indices.astype(np.int64, copy=False)


def validate_partitions(*partitions, n_samples: int) -> None:
    indices = [_indices(partition, n_samples) for partition in partitions]
    joined = np.concatenate(indices)
    if len(np.unique(joined)) != len(joined):
        raise ValueError("Training, validation and test partitions must not overlap")
    if len(joined) != n_samples:
        raise ValueError("Partitions must cover the complete dataset")


def stratified_partitions(labels, *, outer_train=None, outer_test=None,
                          validation_fraction: float = 0.2, test_fraction: float = 0.2,
                          seed: int = 2020) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Reserve test first, then split validation from the remaining outer training set."""
    labels = np.asarray(labels)
    if labels.ndim != 1 or len(np.unique(labels)) < 2:
        raise ValueError("Stratified evaluation requires at least two classes")
    if not 0 < validation_fraction < 1 or not 0 < test_fraction < 1:
        raise ValueError("Split fractions must lie strictly between zero and one")
    if (outer_train is None) != (outer_test is None):
        raise ValueError("Provide both outer training and test indices, or neither")
    if outer_train is None:
        outer = StratifiedShuffleSplit(n_splits=1, test_size=test_fraction, random_state=seed)
        outer_train, outer_test = next(outer.split(np.zeros(len(labels)), labels))
    validate_partitions(outer_train, outer_test, n_samples=len(labels))
    outer_train = _indices(outer_train, len(labels))
    test = _indices(outer_test, len(labels))
    inner = StratifiedShuffleSplit(n_splits=1, test_size=validation_fraction, random_state=seed)
    train_relative, validation_relative = next(inner.split(np.zeros(len(outer_train)), labels[outer_train]))
    train, validation = outer_train[train_relative], outer_train[validation_relative]
    validate_partitions(train, validation, test, n_samples=len(labels))
    return train, validation, test


def fit_training_encoder(model_factory: Callable, fit: Callable, records: Sequence,
                         train_indices):
    """Create one encoder per fold and expose only that fold's training records to SSL."""
    indices = _indices(train_indices, len(records))
    model = model_factory()
    return fit(model, [records[int(index)] for index in indices])


def snapshot_state_dict(state_dict: Mapping[str, Any]) -> dict[str, Any]:
    """Copy tensor storage, including when detach()/cpu() both return shared CPU storage."""
    return {key: value.detach().cpu().clone() for key, value in state_dict.items()}


def classification_metrics(labels, probabilities) -> dict[str, float]:
    labels = np.asarray(labels, dtype=int)
    probabilities = np.asarray(probabilities, dtype=float)
    if labels.ndim != 1 or probabilities.ndim != 2 or len(labels) == 0 or len(labels) != len(probabilities):
        raise ValueError("Metrics require matching nonempty labels and class probabilities")
    num_classes = probabilities.shape[1]
    if num_classes < 2 or np.any(labels < 0) or np.any(labels >= num_classes):
        raise ValueError("Labels must identify a column of the class probability matrix")
    if not np.all(np.isfinite(probabilities)):
        raise ValueError("Class probabilities must be finite")
    predicted = probabilities.argmax(axis=1)
    classes = np.arange(num_classes)
    auc = float("nan")
    if len(np.unique(labels)) == num_classes:
        auc = float(roc_auc_score(labels, probabilities[:, 1] if num_classes == 2 else probabilities,
                                  **({} if num_classes == 2 else {"multi_class": "ovr", "labels": classes})))
    matrix = confusion_matrix(labels, predicted, labels=classes)
    if num_classes == 2:
        negatives = matrix[0].sum()
        specificity = float(matrix[0, 0] / negatives) if negatives else float("nan")
    else:
        specificities = []
        for index in classes:
            false_positive = matrix[:, index].sum() - matrix[index, index]
            negatives = matrix.sum() - matrix[index].sum()
            specificities.append((negatives - false_positive) / negatives if negatives else float("nan"))
        specificity = float(np.mean(specificities))
    return {
        "acc": float(accuracy_score(labels, predicted)),
        "recall": float(recall_score(labels, predicted, labels=classes, average="macro", zero_division=0)),
        "precision": float(precision_score(labels, predicted, labels=classes, average="macro", zero_division=0)),
        "f1": float(f1_score(labels, predicted, labels=classes, average="macro", zero_division=0)),
        "auc": auc,
        "specificity": specificity,
    }


class ValidationCheckpoint:
    """Select by validation accuracy only; earliest tie wins, test is evaluated once."""
    def __init__(self):
        self.epoch = -1
        self.metrics: dict[str, float] = {}
        self.state = None
        self._test_evaluated = False

    def consider(self, epoch: int, metrics: Mapping[str, float], snapshot: Callable[[], Any]) -> bool:
        if self._test_evaluated:
            raise RuntimeError("Checkpoint selection is closed after test evaluation")
        accuracy = float(metrics["acc"])
        if not np.isfinite(accuracy):
            raise ValueError("Validation accuracy must be finite")
        if self.epoch >= 0 and accuracy <= self.metrics["acc"]:
            return False
        self.state = snapshot()
        self.metrics = {key: float(value) for key, value in metrics.items()}
        self.epoch = int(epoch)
        return True

    def evaluate_test(self, restore: Callable[[Any], None], evaluate: Callable[[], Mapping[str, float]]) -> dict[str, float]:
        if self._test_evaluated:
            raise RuntimeError("The selected checkpoint may evaluate test only once")
        if self.epoch < 0:
            raise RuntimeError("No validation checkpoint has been selected")
        restore(self.state)
        self._test_evaluated = True
        test_metrics = evaluate()
        return {
            **{"val_" + key: value for key, value in self.metrics.items()},
            **{"test_" + key: float(value) for key, value in test_metrics.items()},
            "best_val_acc": self.metrics["acc"],
            "best_val_epoch": self.epoch,
        }
