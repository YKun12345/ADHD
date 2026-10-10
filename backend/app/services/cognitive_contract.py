from __future__ import annotations

import re
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

CONTINUOUS_PROTOCOL_ID = "continuous-mobile-v4"


def validate_test_run_id(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", value):
        raise ValueError("test_run_id must contain 1-64 ASCII letters, digits, '.', '_', ':' or '-'")
    return value


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
    canonical_type = result_test_type(test_type, value)
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

    normalized.update(protocol_metadata(test_type, value))
    normalized["raw_result"] = raw
    normalized.setdefault("test_name", TEST_NAMES[canonical_type])
    normalized.setdefault("status_text", "已记录")
    return normalized

WEB_PROTOCOL_ID = "patient-web-preview-v1"
LEGACY_PROTOCOL_ID = "legacy-unversioned"
PROTOCOL_SOURCES = {WEB_PROTOCOL_ID: "patient_web", CONTINUOUS_PROTOCOL_ID: "miniprogram"}
PROTOCOL_LABELS = {WEB_PROTOCOL_ID: "网页简版", CONTINUOUS_PROTOCOL_ID: "连续移动筛查版", LEGACY_PROTOCOL_ID: "历史未标注协议"}
AGE_GROUPS = {"adult", "child", "unspecified", "unknown"}


def _metadata_token(value: Any, maximum: int = 96) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1," + str(maximum) + "}", value) is not None


def validate_protocol_metadata(value: dict[str, Any]) -> None:
    for key in ("source", "protocol_id"):
        if key in value and not _metadata_token(value[key]):
            raise ValueError(f"{key} must be a nonempty ASCII protocol identifier")
    version = value.get("protocol_schema_version")
    if "protocol_schema_version" in value and (type(version) is not int or not 0 <= version <= 1_000_000):
        raise ValueError("protocol_schema_version must be a nonnegative integer")
    if "age_group" in value and (not isinstance(value["age_group"], str) or value["age_group"] not in AGE_GROUPS):
        raise ValueError("unsupported cognitive age_group")
    expected_source = PROTOCOL_SOURCES.get(value.get("protocol_id"))
    if expected_source and "source" in value and value["source"] != expected_source:
        raise ValueError("source does not match the supplied cognitive protocol")


def _historical_web_signature(test_type: str, value: dict[str, Any]) -> bool:
    raw = value.get("raw_result") if isinstance(value.get("raw_result"), dict) else value
    if test_type in {"reaction", "simple_reaction"}:
        return (raw.get("target_rounds") == 5 and "completed_rounds" in raw
                and not any(key in raw for key in ("go_trials", "nogo_trials", "commission_errors", "omission_errors")))
    if test_type == "trail":
        return raw.get("total_points") == 8 and "completed_points" in raw
    if test_type == "digit":
        return ("correct_rounds" in raw and "highest_span" in raw
                and any(key in raw for key in ("failed_span", "final_span", "current_span"))
                and "backward_max_span" not in raw)
    return False


def result_test_type(test_type: str, value: dict[str, Any]) -> str:
    canonical = canonical_test_type(test_type)
    protocol = value.get("protocol_id")
    if canonical == "reaction" and (
        protocol == WEB_PROTOCOL_ID or (not protocol and _historical_web_signature(canonical, value))
    ):
        return "simple_reaction"
    return canonical


def protocol_metadata(test_type: str, value: dict[str, Any]) -> dict[str, Any]:
    # Report reads tolerate old, unvalidated rows; writes validate explicit metadata separately.
    supplied_protocol = value.get("protocol_id")
    protocol = supplied_protocol if _metadata_token(supplied_protocol) else LEGACY_PROTOCOL_ID
    inferred_web = not supplied_protocol and _historical_web_signature(canonical_test_type(test_type), value)
    if inferred_web:
        protocol = WEB_PROTOCOL_ID
    supplied_source = value.get("source")
    source = supplied_source if _metadata_token(supplied_source) else PROTOCOL_SOURCES.get(protocol, "unknown")
    version = value.get("protocol_schema_version")
    if type(version) is not int or not 0 <= version <= 1_000_000:
        version = 1 if inferred_web else 0
    age_group = value.get("age_group")
    if not isinstance(age_group, str) or age_group not in AGE_GROUPS:
        age_group = "unspecified" if protocol == WEB_PROTOCOL_ID else "unknown"
    label = value.get("protocol_label")
    label = label.strip() if isinstance(label, str) and label.strip() else PROTOCOL_LABELS.get(protocol, protocol)
    key = f"{source}|{protocol}|{version}|{age_group}"
    return {
        "source": source, "protocol_id": protocol, "protocol_label": label,
        "protocol_schema_version": version, "age_group": age_group,
        "protocol_inferred": inferred_web or value.get("protocol_inferred") is True,
        "protocol_key": key,
    }


def cognitive_series_id(test_type: str, value: dict[str, Any]) -> str:
    return f"{result_test_type(test_type, value)}|{protocol_metadata(test_type, value)['protocol_key']}"
