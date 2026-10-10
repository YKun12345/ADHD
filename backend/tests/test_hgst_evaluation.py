from __future__ import annotations

import importlib
import importlib.util
from copy import deepcopy

import numpy as np
import pytest


def protocol():
    name = "backend.app.services.hgst_runtime.evaluation"
    assert importlib.util.find_spec(name) is not None, "Independent HGST evaluation protocol is missing"
    return importlib.import_module(name)


def test_each_outer_fold_has_three_disjoint_stratified_partitions():
    evaluation = protocol()
    labels = np.tile([0, 1], 50)
    outer_train = np.arange(80)
    outer_test = np.arange(80, 100)
    train, validation, test = evaluation.stratified_partitions(
        labels, outer_train=outer_train, outer_test=outer_test, seed=17,
    )
    assert set(test) == set(outer_test)
    assert set(train) | set(validation) == set(outer_train)
    assert not set(train) & set(validation)
    assert not set(train) & set(test)
    assert not set(validation) & set(test)
    for partition in (train, validation, test):
        assert set(labels[partition]) == {0, 1}
    repeated = evaluation.stratified_partitions(
        labels, outer_train=outer_train, outer_test=outer_test, seed=17,
    )
    assert all(np.array_equal(left, right) for left, right in zip((train, validation, test), repeated))


def test_deployment_split_reserves_test_before_validation():
    evaluation = protocol()
    labels = np.tile([0, 1], 50)
    partitions = evaluation.stratified_partitions(labels, seed=2020)
    assert [len(partition) for partition in partitions] == [64, 16, 20]
    assert set().union(*(set(partition) for partition in partitions)) == set(range(100))
    assert sum(len(partition) for partition in partitions) == 100


def test_overlapping_outer_test_is_rejected():
    evaluation = protocol()
    with pytest.raises(ValueError, match="overlap"):
        evaluation.stratified_partitions(
            np.tile([0, 1], 20), outer_train=np.arange(32), outer_test=np.arange(30, 40),
        )


def test_validation_ties_keep_metrics_and_weights_from_one_checkpoint():
    evaluation = protocol()
    selection = evaluation.ValidationCheckpoint()
    weights = np.array([1.0, 2.0])
    assert selection.consider(0, {"acc": 0.75, "f1": 0.6, "auc": 0.65}, lambda: deepcopy(weights))
    weights[:] = 9
    assert not selection.consider(1, {"acc": 0.75, "f1": 0.9, "auc": 0.95}, lambda: deepcopy(weights))
    restored = []
    calls = []
    result = selection.evaluate_test(
        lambda state: restored.append(state.copy()),
        lambda: calls.append("test") or {"acc": 0.5, "f1": 0.4, "auc": 0.3},
    )
    assert np.array_equal(restored[0], [1.0, 2.0])
    assert calls == ["test"]
    assert result["best_val_epoch"] == 0
    assert result["val_f1"] == 0.6 and result["val_auc"] == 0.65
    assert result["test_acc"] == 0.5 and result["test_f1"] == 0.4
    with pytest.raises(RuntimeError, match="once"):
        selection.evaluate_test(lambda state: None, lambda: calls.append("again"))
    assert calls == ["test"]


def test_zero_accuracy_still_selects_a_real_checkpoint():
    evaluation = protocol()
    selection = evaluation.ValidationCheckpoint()
    assert selection.consider(0, {"acc": 0.0}, lambda: "epoch-zero")
    assert selection.state == "epoch-zero"


def test_all_metrics_come_from_the_same_predictions():
    evaluation = protocol()
    metrics = evaluation.classification_metrics(
        np.array([0, 0, 1, 1]),
        np.array([[0.8, 0.2], [0.4, 0.6], [0.3, 0.7], [0.1, 0.9]]),
    )
    assert metrics["acc"] == 0.75
    assert metrics["specificity"] == 0.5
    assert metrics["recall"] == 0.75
    assert metrics["precision"] == pytest.approx(5 / 6)
    assert metrics["f1"] == pytest.approx(11 / 15)
    assert metrics["auc"] == 1.0


def test_missing_class_metrics_are_explicitly_undefined():
    evaluation = protocol()
    metrics = evaluation.classification_metrics(np.ones(3, dtype=int), np.tile([0.2, 0.8], (3, 1)))
    assert np.isnan(metrics["auc"])
    assert np.isnan(metrics["specificity"])


def test_state_snapshot_does_not_share_cpu_parameter_storage():
    evaluation = protocol()

    class ArrayParameter:
        def __init__(self, value):
            self.value = np.asarray(value, dtype=float)

        def detach(self):
            return self

        def cpu(self):
            return self

        def clone(self):
            return ArrayParameter(self.value.copy())

    parameter = ArrayParameter([2.0, 3.0])
    snapshot = evaluation.snapshot_state_dict({"weight": parameter})
    parameter.value[:] = 10
    assert np.array_equal(snapshot["weight"].value, [2.0, 3.0])


def test_each_fold_pretrains_only_its_training_records_with_a_fresh_encoder():
    evaluation = protocol()
    all_records = list(range(12))
    seen = []

    def factory():
        return {"updates": 0}

    def fit(model, training_records):
        model["updates"] += 1
        seen.append(list(training_records))
        return model

    first = evaluation.fit_training_encoder(factory, fit, all_records, [0, 2, 4])
    second = evaluation.fit_training_encoder(factory, fit, all_records, [1, 3, 5])
    assert seen == [[0, 2, 4], [1, 3, 5]]
    assert first is not second
    assert first["updates"] == second["updates"] == 1


def test_untrained_synthetic_classifier_is_removed():
    from backend.app.services.hgst_runtime import service
    assert not hasattr(service, "_run_lightweight_timeseries_inference"), "Synthetic-anchor inference must be removed"
