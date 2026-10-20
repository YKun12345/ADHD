"""Frozen legacy wording and 12 engineering configs, explicitly unapproved."""
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path

from fastapi import HTTPException
from backend.app.core.config import settings

REGISTRY_SHA256 = "90cdfdb443c329b18df9e46ba0b14e2387f5675987a1a8f6889acde69ea27bc3"
VERSION = "W03-demo-1"
# This exact list belongs to the already saved W03 template fingerprint. Keep
# it for old sessions; runtime capability messages are maintained separately.
FROZEN_BLOCKERS = ["official_source_and_chinese_version_equivalence_not_verified", "project_license_not_verified", "professional_age_scoring_and_interpretation_approval_missing", "institutional_real_user_admission_missing", "W04_W05_submission_transaction_not_connected"]
BLOCKERS = FROZEN_BLOCKERS[:-1]
USAGE_NOTICE = "参考评估用于记录和辅助了解注意状态，不替代医生诊断；专业意见和计划由医生确认。"


def reference_enabled():
    option = settings.ASSESSMENT_REFERENCE_ENABLED
    return option in {"true", "1", "yes"} or (option == "auto" and settings.APP_ENV in {"development", "test"})


def digest(value):
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def _registry():
    data = Path(__file__).with_name("assessment_registry.json").read_bytes()
    if sha256(data).hexdigest() != REGISTRY_SHA256:
        raise HTTPException(503, "Frozen assessment registry integrity mismatch.")
    return json.loads(data)


def templates():
    registry = _registry()
    rows = []
    for age_group, minimum, maximum in (("adult", 18, 120), ("child", 6, 17)):
        scale = next(row for row in registry["scales"] if row["age_group"] == age_group)
        config = deepcopy(scale["config"])
        config["recall_window"] = "P6M"
        config["scoring_source"] = "backend/app/api/routes/patient.py:_asrs_scores" if age_group == "adult" else "backend/app/api/routes/patient.py:_snap_scores"
        config["scoring_status"] = "legacy_project_rules_not_clinically_verified"
        items = [{"key":scale["scale_type"], "kind":"scale", "instrument":scale["scale_type"], "title":config["title"] + "（工程演示）", "respondent_kind":"self" if age_group == "adult" else "primary_guardian", "protocol_id":"project-legacy-scale-v1", "protocol_schema_version":1, "config_digest":digest(config), "config":config, "recall_window":"P6M", "content_digest":scale["content_sha256"], "quality_rules":["actual_complete_answers_required", "actual_observer_identity_required", "P6M_overlap_not_short_term_treatment_effect"]}]
        for task in registry["cognitive_configs"]:
            if task["age_group"] == age_group:
                items.append({"key":task["task_id"], "kind":"cognitive", "instrument":task["task_id"], "title":task["task_id"] + "（工程演示）", "respondent_kind":None, "protocol_id":task["protocol_id"], "protocol_schema_version":task["schema_version"], "config_digest":task["project_config_sha256"], "config":deepcopy(task["config"]), "recall_window":None, "content_digest":None, "quality_rules":["actual_trials_required", "practice_and_timing_quality_required", "device_equivalence_not_verified", "repeat_exposure_and_interval_required"]})
        row = {"id":age_group + "-demo", "version":VERSION, "title":("成人" if age_group == "adult" else "儿童") + "评估工程演示", "age_group":age_group, "minimum_age":minimum, "maximum_age":maximum, "demonstration_only":True, "source_status":"project_legacy_unverified", "license_status":"not_verified", "professional_approval":None, "allowed_report_types":[], "blockers":list(FROZEN_BLOCKERS), "items":items}
        row["template_digest"] = digest(row)
        # Admission and presentation are live metadata, outside the frozen
        # question/protocol fingerprint. No old attempts or receipts are changed.
        row.update(blockers=list(BLOCKERS), usage_scope="reference_assessment", usage_notice=USAGE_NOTICE)
        row["admission_status"] = ("test_only" if settings.APP_ENV == "test" else "reference_use") if reference_enabled() else "blocked"
        row["title"] = ("成人" if age_group == "adult" else "儿童") + "参考评估"
        rows.append(row)
    return rows


def registry_response(patient):
    rows = [row for row in templates() if patient.age is not None and row["age_group"] == patient.patient_type.value and row["minimum_age"] <= patient.age <= row["maximum_age"]]
    blockers = [] if reference_enabled() else list(BLOCKERS)
    if not rows:
        blockers.append("no_applicable_engineering_age_template")
    return {"patient_id":patient.id, "registry_digest":REGISTRY_SHA256, "items":rows, "blockers":blockers}


def select_template(template_id, version, patient, *, require_executable=True):
    row = next((row for row in templates() if row["id"] == template_id and row["version"] == version), None)
    if row is None:
        raise HTTPException(422, "Unknown assessment template or version.")
    if patient.age is None or patient.patient_type.value != row["age_group"] or not row["minimum_age"] <= patient.age <= row["maximum_age"]:
        raise HTTPException(422, "Template is not applicable to the current patient age/profile.")
    if require_executable and row["admission_status"] not in {"test_only", "reference_use"}:
        raise HTTPException(403, {"message":"Reference assessments are disabled on this service.", "blockers":row["blockers"]})
    return row
