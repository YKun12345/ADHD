from __future__ import annotations

import re
import hashlib
import json
import math
from decimal import Decimal
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
CONTINUOUS_SCHEMA_VERSION = 6


def validate_formal_attempt_source(protocol_id: str, schema_version: int, platform: str) -> None:
    """Full executors share frozen tasks; source/device never imply equivalence."""
    if protocol_id != CONTINUOUS_PROTOCOL_ID or schema_version != CONTINUOUS_SCHEMA_VERSION or platform not in {"miniprogram", "web"}:
        raise ValueError("Formal cognitive attempts require the frozen continuous-mobile-v4/schema6 complete executor and an explicit supported platform.")


def reject_legacy_assessment_claims(value) -> None:
    fields = {"assessment_id", "assessment_item_id", "task_attempt_id", "attempt_id", "actor_user_id", "submitter_user_id", "acceptance_status", "execution_status"}
    if isinstance(value, dict) and fields.intersection(value):
        raise ValueError("Legacy submission cannot attach or declare a new assessment/attempt context; use the versioned submission contract.")


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


def _accuracy_percent(value: Any, *, already_percent=False) -> float | int | None:
    number = _number(value)
    if number is None:
        return None
    if not already_percent and 0 <= number <= 1:
        return _scale_number(number,100)
    return number


def _scale_number(value,multiplier):
    scaled = Decimal(str(value))*Decimal(str(multiplier))
    return int(scaled) if scaled == scaled.to_integral_value() else float(scaled)


def _derived_accuracy(source: dict[str, Any], *, already_percent=False) -> float | int | None:
    direct = _accuracy_percent(source.get("accuracy"),already_percent=already_percent)
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
            destination[destination_key] = _scale_number(value,multiplier)
            return


def _legacy_raw_result(test_type: str, source: dict[str, Any], *, already_percent=False) -> dict[str, Any]:
    raw: dict[str, Any] = {}
    accuracy = _derived_accuracy(source,already_percent=already_percent)

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
    if "normalization_version" in value and (type(value["normalization_version"]) is not int or value["normalization_version"] != 1):
        raise ValueError("Canonical numeric representation version must be integer 1 when supplied.")
    validate_numeric_aliases(value,test_type)
    already_percent = value.get("normalization_version") == 1
    canonical_type = result_test_type(test_type, value)
    normalized = deepcopy(value)
    supplied_raw = normalized.get("raw_result")
    if isinstance(supplied_raw, dict):
        raw = deepcopy(supplied_raw)
        # Canonicalize aliases inside raw_result as well as legacy top-level
        # metrics. Retain all unknown evidence instead of reconstructing it.
        raw.update(_legacy_raw_result(canonical_type,supplied_raw,already_percent=already_percent))
        for canonical,alias,_ in _numeric_aliases(canonical_type):
            if canonical in raw:
                raw.pop(alias,None)
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
        raw = _legacy_raw_result(canonical_type, normalized,already_percent=already_percent)

    normalized.update(protocol_metadata(test_type, value))
    normalized["raw_result"] = raw
    if "accuracy" in normalized and _number(normalized["accuracy"]) is not None:
        normalized["accuracy"] = _accuracy_percent(normalized["accuracy"],already_percent=already_percent)
    normalized["normalization_version"] = 1
    normalized.setdefault("test_name", TEST_NAMES[canonical_type])
    normalized.setdefault("status_text", "已记录")
    return normalized


NUMERIC_ALIASES = (("average_reaction_time_ms","avg_reaction_ms",1),("accuracy","correct_rate",1),("elapsed_ms","duration_s",1000),("highest_span","max_span",1))
NUMERIC_FIELDS = {"average_reaction_time_ms","avg_reaction_ms","accuracy","correct_rate","elapsed_ms","duration_s","highest_span","max_span","false_starts","forward_max_span","backward_max_span","n","total_trials","correct_trials","go_trials","nogo_trials","commission_errors","omission_errors","errors","wrong","correct","median_reaction_time_ms","interference_effect_ms","conflict_effect_ms","d_prime","correct_digits","total_digits"}


def _numeric_aliases(test_type):
    return NUMERIC_ALIASES+(("errors","wrong",1),) if canonical_test_type(test_type) == "trail" else NUMERIC_ALIASES


def validate_numeric_aliases(value: dict[str, Any],test_type: str) -> None:
    layers = []
    for source in (value,value.get("raw_result")):
        if not isinstance(source, dict):
            continue
        metrics = {}
        for key in NUMERIC_FIELDS.intersection(source):
            number = source[key]
            if number is None:
                continue
            if _number(number) is None or abs(number) > 10**100 or (type(number) is float and not math.isfinite(number)):
                raise ValueError("Cognitive numeric evidence must contain finite numbers, never booleans.")
            canonical,multiplier = key,1
            for target,alias,factor in _numeric_aliases(test_type):
                if key == alias:
                    canonical,multiplier = target,factor
                    break
            number = _accuracy_percent(number,already_percent=value.get("normalization_version") == 1 and key == "accuracy") if canonical == "accuracy" else _scale_number(number,multiplier)
            if canonical in metrics and metrics[canonical] != number:
                raise ValueError("Conflicting cognitive numeric aliases are not an equivalent submission.")
            metrics[canonical] = number
        layers.append(metrics)
    if len(layers) == 2 and any(layers[0][key] != layers[1][key] for key in layers[0].keys() & layers[1].keys()):
        raise ValueError("Top-level and raw cognitive metrics contain contradictory actual evidence.")


def canonical_digest(value: Any) -> str:
    def normalize(item):
        if isinstance(item, bool) or item is None or isinstance(item, str):
            return item
        if isinstance(item, (int, float)):
            if abs(item) > 10**100 or type(item) is float and not math.isfinite(item):
                raise ValueError("Submission content must contain finite numbers.")
            return int(item) if item == int(item) else item
        if isinstance(item, list):
            return [normalize(child) for child in item]
        if isinstance(item, dict):
            return {key:normalize(child) for key,child in item.items()}
        raise ValueError("Submission content must be JSON.")
    return hashlib.sha256(json.dumps(normalize(value),sort_keys=True,ensure_ascii=False,separators=(",",":"),allow_nan=False).encode("utf-8")).hexdigest()


def legacy_cognitive_digest(patient_id: int, test_type: str, result: dict[str, Any]) -> str:
    canonical = result_test_type(test_type, result)
    normalized = normalize_result_json(canonical, result)
    # These fields duplicate server protocol projections, never actual evidence.
    for key in ("protocol_key", "protocol_label", "protocol_inferred", "normalization_version"):
        normalized.pop(key, None)
    raw = normalized["raw_result"]
    aliases = _numeric_aliases(canonical)
    for key, alias, multiplier in aliases:
        if key not in raw:
            continue
        raw.pop(alias,None)
        for top_key in (key,alias):
            if top_key in normalized:
                # Legacy normalizer already froze the canonical metric.
                normalized.pop(top_key)
    for key in ("false_starts","forward_max_span","backward_max_span","n"):
        if key in raw and normalized.get(key) == raw[key]:
            normalized.pop(key,None)
    return canonical_digest({"patient_id":patient_id,"test_type":canonical,"result_json":normalized})

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
