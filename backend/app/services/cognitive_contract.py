from __future__ import annotations

from copy import deepcopy
from typing import Any


CANONICAL_COGNITIVE_TYPES = (
    "reaction",
    "simple_reaction",
    "stroop",
    "trail",
    "flanker",
    "nback",
    "digit",
)

COGNITIVE_TYPE_ALIASES = {
    "gonogo": "reaction",
    "go_no_go": "reaction",
    "simple-reaction": "simple_reaction",
    "digit_span": "digit",
    "digit-span": "digit",
}

TEST_NAMES = {
    "reaction": "Go/No-Go",
    "simple_reaction": "简单反应时",
    "stroop": "Stroop",
    "trail": "连线测试",
    "flanker": "Flanker",
    "nback": "2-back",
    "digit": "数字广度",
}


def canonical_test_type(value: str) -> str:
    normalized = value.strip().lower()
    normalized = COGNITIVE_TYPE_ALIASES.get(normalized, normalized)
    if normalized not in CANONICAL_COGNITIVE_TYPES:
        raise ValueError(f"unsupported cognitive test type: {value}")
    return normalized


def _number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def _accuracy_percent(value: Any) -> float | int | None:
    number = _number(value)
    if number is None:
        return None
    if 0 <= number <= 1:
        return round(float(number) * 100, 2)
    return number


def _derived_accuracy(source: dict[str, Any]) -> float | int | None:
    direct = _accuracy_percent(source.get("accuracy"))
    if direct is not None:
        return direct
    direct = _accuracy_percent(source.get("correct_rate"))
    if direct is not None:
        return direct
    correct = _number(source.get("correct"))
    total = _number(source.get("total_trials"))
    if correct is not None and total not in {None, 0}:
        return round(float(correct) / float(total) * 100, 2)
    return None


def _copy_number(
    destination: dict[str, Any],
    source: dict[str, Any],
    destination_key: str,
    *source_keys: str,
    multiplier: float = 1.0,
) -> None:
    for key in source_keys:
        value = _number(source.get(key))
        if value is not None:
            destination[destination_key] = value * multiplier
            return


def _legacy_raw_result(test_type: str, source: dict[str, Any]) -> dict[str, Any]:
    raw: dict[str, Any] = {}
    accuracy = _derived_accuracy(source)

    if test_type in {"reaction", "simple_reaction", "stroop", "flanker"}:
        _copy_number(
            raw,
            source,
            "average_reaction_time_ms",
            "average_reaction_time_ms",
            "avg_reaction_ms",
        )
    if test_type == "trail":
        _copy_number(raw, source, "elapsed_ms", "elapsed_ms")
        if "elapsed_ms" not in raw:
            _copy_number(raw, source, "elapsed_ms", "duration_s", multiplier=1000.0)
        _copy_number(raw, source, "errors", "errors", "wrong")
    if test_type == "reaction":
        _copy_number(raw, source, "false_starts", "false_starts")
    if test_type == "digit":
        _copy_number(raw, source, "forward_max_span", "forward_max_span")
        _copy_number(raw, source, "backward_max_span", "backward_max_span")
        _copy_number(raw, source, "highest_span", "highest_span", "max_span")
        if "highest_span" not in raw:
            spans = [
                value
                for value in (
                    _number(source.get("forward_max_span")),
                    _number(source.get("backward_max_span")),
                )
                if value is not None
            ]
            if spans:
                raw["highest_span"] = max(spans)
    if test_type == "nback":
        _copy_number(raw, source, "n", "n")

    if accuracy is not None:
        raw["accuracy"] = accuracy
    return raw


def normalize_result_json(test_type: str, value: dict[str, Any]) -> dict[str, Any]:
    canonical_type = canonical_test_type(test_type)
    normalized = deepcopy(value)
    supplied_raw = normalized.get("raw_result")
    if isinstance(supplied_raw, dict):
        raw = deepcopy(supplied_raw)
        if "accuracy" in raw:
            accuracy = _accuracy_percent(raw.get("accuracy"))
            if accuracy is not None:
                raw["accuracy"] = accuracy
        if canonical_type == "digit" and _number(raw.get("highest_span")) is None:
            spans = [
                value
                for value in (
                    _number(raw.get("forward_max_span")),
                    _number(raw.get("backward_max_span")),
                    _number(raw.get("max_span")),
                )
                if value is not None
            ]
            if spans:
                raw["highest_span"] = max(spans)
    else:
        raw = _legacy_raw_result(canonical_type, normalized)

    normalized["raw_result"] = raw
    normalized.setdefault("test_name", TEST_NAMES[canonical_type])
    normalized.setdefault("status_text", "已记录")
    return normalized
