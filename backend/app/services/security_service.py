from __future__ import annotations

import hashlib
import hmac
import json
import math
import secrets
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session
from backend.app.core.data_encryption import scoped_key

from backend.app.models.cognitive_test import CognitiveTest
from backend.app.models.patient import Patient
from backend.app.models.scale_result import ScaleResult
from backend.app.models.security import (
    SecurityAuditLog,
    SecurityLogChainHead,
    SecurityAuditTask,
    SecurityCipherRecord,
    SecurityMcsNode,
    SecurityPatientAssignment,
    SecuritySystemConfig,
    SecurityUserKey,
)
from backend.app.models.tracking_log import TrackingLog
from backend.app.models.user import User, UserRole, UserSubrole


SECURITY_SCHEME_VERSION = "paillier-aesgcm-evidence-v2"
LOCAL_MCS_MODE = "local_mcs_db"
DEFAULT_MAX_RECORDS = 128
DEFAULT_MCS_NODE_CODE = "LOCAL-MCS-001"

DIMENSION_PROFILES: dict[str, dict[str, Any]] = {
    "scale": {
        "labels": ["total_score", "risk_score", "attention_control", "hyperactivity"],
        "max_value": 5000,
    },
    "tracking": {
        "labels": ["mood_value", "focus_minutes", "test_score_scaled"],
        "max_value": 10000,
    },
    "cognitive": {
        "labels": ["performance_score", "accuracy_score", "latency_score"],
        "max_value": 200000,
    },
}

RISK_SCORE_MAP = {
    "low": 100,
    "medium": 200,
    "high": 300,
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _hmac_digest(secret: str, payload: dict[str, Any]) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        _json_dumps(payload).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _gcd(a: int, b: int) -> int:
    while b:
        a, b = b, a % b
    return a


def _lcm(a: int, b: int) -> int:
    return abs(a * b) // _gcd(a, b)


def _is_probable_prime(candidate: int, rounds: int = 32) -> bool:
    if candidate < 2:
        return False
    small_primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29]
    for prime in small_primes:
        if candidate == prime:
            return True
        if candidate % prime == 0:
            return False

    s = 0
    d = candidate - 1
    while d % 2 == 0:
        s += 1
        d //= 2

    for _ in range(rounds):
        a = secrets.randbelow(candidate - 3) + 2
        x = pow(a, d, candidate)
        if x in (1, candidate - 1):
            continue
        for _ in range(s - 1):
            x = pow(x, 2, candidate)
            if x == candidate - 1:
                break
        else:
            return False
    return True


def _generate_prime(bits: int) -> int:
    while True:
        candidate = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if _is_probable_prime(candidate):
            return candidate


def _generate_paillier_keypair(bits: int = 2048) -> dict[str, str]:
    p = _generate_prime(bits // 2)
    q = _generate_prime(bits // 2)
    while q == p:
        q = _generate_prime(bits // 2)

    n = p * q
    g = n + 1
    lam = _lcm(p - 1, q - 1)
    nsquare = n * n
    l_value = (pow(g, lam, nsquare) - 1) // n
    mu = pow(l_value, -1, n)

    return {
        "n": str(n),
        "g": str(g),
        "lambda": str(lam),
        "mu": str(mu),
    }


def _encrypt_with_paillier(n: int, g: int, message: int) -> str:
    nsquare = n * n
    while True:
        r = secrets.randbelow(n - 1) + 1
        if _gcd(r, n) == 1:
            break
    ciphertext = (pow(g, message, nsquare) * pow(r, n, nsquare)) % nsquare
    return str(ciphertext)


def _decrypt_with_paillier(n: int, lam: int, mu: int, ciphertext: int) -> int:
    nsquare = n * n
    l_value = (pow(ciphertext, lam, nsquare) - 1) // n
    return (l_value * mu) % n


def _build_profile_params(
    labels: list[str], max_value: int, max_records: int
) -> dict[str, Any]:
    max_sum = max_value * max_records
    max_square_sum = (max_value**2) * max_records
    boundary = max(max_sum, max_square_sum) + 1

    sequence: list[int] = []
    running_total = 0
    for index in range(len(labels) * 2):
        next_value = 1 if index == 0 else running_total * boundary + 1
        sequence.append(next_value)
        running_total += next_value

    return {
        "labels": labels,
        "max_value": max_value,
        "max_records": max_records,
        "boundary": str(boundary),
        "sequence": [str(item) for item in sequence],
    }


def _load_profile(config: SecuritySystemConfig, source_type: str) -> dict[str, Any]:
    profile = (config.profile_params_json or {}).get(source_type)
    if not profile:
        raise ValueError(f"Unsupported source type: {source_type}")
    return {
        **profile,
        "boundary": int(profile["boundary"]),
        "sequence": [int(item) for item in profile["sequence"]],
    }


def _load_paillier_params(config: SecuritySystemConfig) -> dict[str, int]:
    public_params = config.public_params_json or {}
    secret_params = config.secret_params_json or {}
    return {
        "n": int(public_params["n"]),
        "g": int(public_params["g"]),
        "lambda": int(secret_params["lambda"]),
        "mu": int(secret_params["mu"]),
    }


def get_security_config(db: Session) -> SecuritySystemConfig | None:
    return db.scalar(
        select(SecuritySystemConfig).order_by(SecuritySystemConfig.id.desc())
    )


def get_default_mcs_node(db: Session) -> SecurityMcsNode | None:
    return db.scalar(
        select(SecurityMcsNode)
        .where(
            SecurityMcsNode.node_code == DEFAULT_MCS_NODE_CODE,
            SecurityMcsNode.is_active.is_(True),
        )
        .order_by(SecurityMcsNode.id.desc())
    )


def get_primary_dac_user(db: Session) -> User | None:
    return db.scalar(
        select(User)
        .where(
            User.role == UserRole.RESEARCHER,
            User.subrole == UserSubrole.DAC,
            User.is_active.is_(True),
        )
        .order_by(User.id.asc())
    )


def ensure_patient_security_assignment(
    db: Session,
    patient: Patient,
    *,
    actor_user_id: int | None = None,
) -> SecurityPatientAssignment:
    assignment = db.scalar(
        select(SecurityPatientAssignment).where(
            SecurityPatientAssignment.patient_id == patient.id
        )
    )
    dac_user = get_primary_dac_user(db)
    mcs_node = get_default_mcs_node(db)

    if assignment is None:
        assignment = SecurityPatientAssignment(
            patient_id=patient.id,
            patient_user_id=patient.user_id,
            assigned_dac_user_id=dac_user.id if dac_user else None,
            assigned_mcs_node_id=mcs_node.id if mcs_node else None,
            assignment_status="active",
            assignment_version=1,
        )
        db.add(assignment)
    else:
        assignment.patient_user_id = patient.user_id
        if assignment.assigned_dac_user_id is None and dac_user is not None:
            assignment.assigned_dac_user_id = dac_user.id
        if assignment.assigned_mcs_node_id is None and mcs_node is not None:
            assignment.assigned_mcs_node_id = mcs_node.id
        # Preserve explicit suspension/revocation during startup synchronization.

    db.flush()
    return assignment


def _append_audit_log(
    db: Session,
    *,
    action: str,
    status: str,
    message: str,
    actor_user_id: int | None = None,
    patient_id: int | None = None,
    audit_task_id: int | None = None,
    detail_json: dict[str, Any] | None = None,
) -> SecurityAuditLog:
    if db.get_bind().dialect.name == "sqlite":
        # A database write lock lasts until commit; SQLite ignores SELECT FOR UPDATE.
        db.execute(
            update(SecurityLogChainHead)
            .where(SecurityLogChainHead.id == 1)
            .values(last_log_id=SecurityLogChainHead.last_log_id)
        )
    head = db.scalar(
        select(SecurityLogChainHead)
        .where(SecurityLogChainHead.id == 1)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if head is None:
        _ensure_log_chain_head(db)
        head = db.get(SecurityLogChainHead, 1)
    if head is None:
        head = SecurityLogChainHead(
            id=1, last_hash="GENESIS", state_tag=_chain_tag(None, "GENESIS")
        )
        db.add(head)
        db.flush()
    if not hmac.compare_digest(
        head.state_tag, _chain_tag(head.last_log_id, head.last_hash)
    ):
        raise ValueError("Audit chain head integrity mismatch.")
    log = SecurityAuditLog(
        audit_task_id=audit_task_id,
        patient_id=patient_id,
        actor_user_id=actor_user_id,
        action=action,
        status=status,
        message=message,
        detail_json=detail_json or {},
        created_at=_utcnow(),
        previous_hash=head.last_hash,
    )
    db.add(log)
    db.flush()
    log.entry_hash = _log_hash(log)
    head.last_log_id = log.id
    head.last_hash = log.entry_hash
    head.state_tag = _chain_tag(head.last_log_id, head.last_hash)
    db.flush()
    return log


def _ensure_system_ready(config: SecuritySystemConfig | None) -> SecuritySystemConfig:
    if config is None or not config.is_initialized:
        raise ValueError("Security system has not been initialized yet.")
    expected = (config.secret_params_json or {}).get("public_config_digest")
    if not expected or not hmac.compare_digest(
        expected, _security_config_digest(config)
    ):
        raise ValueError(
            "Security configuration integrity failed; restore the authenticated configuration."
        )
    return config


def initialize_security_system(db: Session, actor: User) -> SecuritySystemConfig:
    if actor.role != UserRole.RESEARCHER or actor.subrole != UserSubrole.DAC:
        raise ValueError("DAC permission required.")
    existing = get_security_config(db)
    if existing and existing.is_initialized:
        return _ensure_system_ready(existing)

    _ensure_log_chain_head(db)
    keypair = _generate_paillier_keypair()
    profile_params = {
        source_type: _build_profile_params(
            labels=profile["labels"],
            max_value=profile["max_value"],
            max_records=DEFAULT_MAX_RECORDS,
        )
        for source_type, profile in DIMENSION_PROFILES.items()
    }

    config = existing or SecuritySystemConfig()
    config.is_initialized = True
    config.initialized_by_user_id = actor.id
    config.system_version = SECURITY_SCHEME_VERSION
    config.storage_mode = LOCAL_MCS_MODE
    config.public_params_json = {
        "n": keypair["n"],
        "g": keypair["g"],
    }
    config.secret_params_json = {
        "lambda": keypair["lambda"],
        "mu": keypair["mu"],
        "audit_secret": secrets.token_hex(32),
        "audit_log_chain_version": 1,
    }
    config.profile_params_json = profile_params
    config.updated_at = _utcnow()

    if existing is None:
        db.add(config)
    db.flush()

    config.secret_params_json = {
        **config.secret_params_json,
        "public_config_digest": _security_config_digest(config),
    }
    db.flush()
    users = db.scalars(select(User)).all()
    for user in users:
        provision_security_materials_for_user(db, user, auto_commit=False)

    sync_security_runtime_entities(db, actor_user_id=actor.id)
    _append_audit_log(
        db,
        action="system_init",
        status="success",
        message="安全系统已初始化，本地 MCS 模拟存储层已就绪。",
        actor_user_id=actor.id,
        detail_json={
            "system_version": SECURITY_SCHEME_VERSION,
            "storage_mode": LOCAL_MCS_MODE,
        },
    )
    db.commit()
    db.refresh(config)
    return config


def provision_security_materials_for_user(
    db: Session,
    user: User,
    *,
    auto_commit: bool = True,
) -> SecurityUserKey | None:
    config = get_security_config(db)
    if config is None or not config.is_initialized:
        return None

    existing = db.scalar(
        select(SecurityUserKey)
        .where(SecurityUserKey.user_id == user.id, SecurityUserKey.is_active.is_(True))
        .order_by(SecurityUserKey.id.desc())
    )
    if existing is not None:
        return existing

    patient = db.scalar(select(Patient).where(Patient.user_id == user.id))
    if patient is not None:
        ensure_patient_security_assignment(db, patient, actor_user_id=user.id)
    public_id = secrets.token_hex(8)
    private_seed = secrets.token_hex(16)
    key_role = (
        user.subrole.value
        if user.subrole is not None
        else ("patient" if user.role == UserRole.PATIENT else "researcher")
    )
    fingerprint = _hash_text(f"{user.id}:{user.email}:{public_id}:{private_seed}")[:32]

    record = SecurityUserKey(
        user_id=user.id,
        patient_id=patient.id if patient else None,
        key_role=key_role,
        key_version=1,
        public_key_json={
            "public_id": public_id,
            "scheme": SECURITY_SCHEME_VERSION,
            "role": key_role,
        },
        private_key_json={
            "seed": private_seed,
        },
        key_fingerprint=fingerprint,
        is_active=True,
    )
    db.add(record)
    db.flush()

    _append_audit_log(
        db,
        action="key_provision",
        status="success",
        message="已为授权账户分配安全标识材料。",
        actor_user_id=user.id,
        patient_id=patient.id if patient else None,
        detail_json={"fingerprint": fingerprint, "key_role": key_role},
    )

    if auto_commit:
        db.commit()
        db.refresh(record)
    return record


def _pack_dimensions(profile: dict[str, Any], dimension_values: dict[str, int]) -> int:
    labels: list[str] = profile["labels"]
    sequence: list[int] = profile["sequence"]
    values = [max(0, int(dimension_values.get(label, 0))) for label in labels]
    squares = [value * value for value in values]

    total = 0
    for index, value in enumerate(values):
        total += sequence[index] * value
    for index, value in enumerate(squares):
        total += sequence[len(labels) + index] * value
    return total


def _unpack_aggregate(
    profile: dict[str, Any], packed_value: int, record_count: int
) -> dict[str, Any]:
    labels: list[str] = profile["labels"]
    sequence: list[int] = profile["sequence"]
    decoded = [0 for _ in sequence]
    remaining = packed_value

    for index in range(len(sequence) - 1, -1, -1):
        base = sequence[index]
        decoded[index] = remaining // base
        remaining -= decoded[index] * base

    stats: dict[str, Any] = {}
    for index, label in enumerate(labels):
        total = decoded[index]
        square_total = decoded[len(labels) + index]
        average = total / record_count if record_count else 0.0
        variance = (
            max(0.0, (square_total / record_count) - (average**2))
            if record_count
            else 0.0
        )
        stats[label] = {
            "sum": round(total, 4),
            "average": round(average, 4),
            "variance": round(variance, 4),
        }
    return stats


def _record_digest_payload(
    *,
    patient_id: int,
    source_type: str,
    source_record_id: int | None,
    time_bucket: str,
    encrypted_payload: str,
    key_fingerprint: str,
    metadata_json: dict[str, Any],
) -> dict[str, Any]:
    return {
        "patient_id": patient_id,
        "source_type": source_type,
        "source_record_id": source_record_id,
        "time_bucket": time_bucket,
        "encrypted_payload": encrypted_payload,
        "key_fingerprint": key_fingerprint,
        "metadata_json": metadata_json,
    }


def _upsert_cipher_record(
    db: Session,
    *,
    patient: Patient,
    user_key: SecurityUserKey,
    source_type: str,
    source_record_id: int,
    time_bucket: str,
    metadata_json: dict[str, Any],
    dimension_values: dict[str, int],
) -> SecurityCipherRecord | None:
    config = get_security_config(db)
    if config is None or not config.is_initialized:
        return None

    _ensure_system_ready(config)
    db.flush()  # Capture the pending authorized business update before hashing.
    previous = db.scalar(
        select(SecurityCipherRecord)
        .where(
            SecurityCipherRecord.patient_id == patient.id,
            SecurityCipherRecord.source_type == source_type,
            SecurityCipherRecord.source_record_id == source_record_id,
        )
        .order_by(SecurityCipherRecord.id.desc())
    )
    source = _source_record(db, source_type, source_record_id)
    source_digest = _source_digest(source)
    if (
        previous
        and (previous.metadata_json or {}).get("source_digest") == source_digest
    ):
        return previous
    profile = _load_profile(config, source_type)
    if any(
        not 0 <= value <= profile["max_value"] for value in dimension_values.values()
    ):
        raise ValueError("Audit value exceeds the declared packing bounds.")
    paillier = _load_paillier_params(config)
    assignment = ensure_patient_security_assignment(
        db, patient, actor_user_id=patient.user_id
    )
    if assignment.assignment_status != "active":
        return None
    metadata_json = {
        **metadata_json,
        "source_digest": source_digest,
        "evidence_version": int(
            (previous.metadata_json or {}).get("evidence_version", 0)
        )
        + 1
        if previous
        else 1,
        "supersedes_record_id": previous.id if previous else None,
        "previous_integrity_digest": previous.integrity_digest if previous else None,
        "patient_assignment_id": assignment.id,
        "mcs_node_id": assignment.assigned_mcs_node_id,
        "dimension_labels": profile["labels"],
        "cipher_version": SECURITY_SCHEME_VERSION,
    }
    if source_type == "cognitive":
        from backend.app.services.cognitive_contract import (
            protocol_metadata,
            result_test_type,
        )

        metadata_json.update(
            protocol_metadata(source.test_type, source.result_json or {})
        )
        metadata_json["canonical_test_type"] = result_test_type(
            source.test_type, source.result_json or {}
        )
    metadata_json["audit_group"] = _audit_group_from_metadata(
        source_type, metadata_json
    )
    encrypted_payload = _encrypt_with_paillier(
        paillier["n"], paillier["g"], _pack_dimensions(profile, dimension_values)
    )
    digest = _hmac_digest(
        config.secret_params_json["audit_secret"],
        _record_digest_payload(
            patient_id=patient.id,
            source_type=source_type,
            source_record_id=source_record_id,
            time_bucket=time_bucket,
            encrypted_payload=encrypted_payload,
            key_fingerprint=user_key.key_fingerprint,
            metadata_json=metadata_json,
        ),
    )
    record = SecurityCipherRecord(
        patient_id=patient.id,
        source_type=source_type,
        source_record_id=source_record_id,
        patient_assignment_id=assignment.id,
        mcs_node_id=assignment.assigned_mcs_node_id,
        time_bucket=time_bucket,
        dimension_labels_json=profile["labels"],
        metadata_json=metadata_json,
        encrypted_payload=encrypted_payload,
        integrity_digest=digest,
        key_fingerprint=user_key.key_fingerprint,
        cipher_version=SECURITY_SCHEME_VERSION,
    )
    db.add(record)
    db.flush()
    _append_audit_log(
        db,
        action="evidence_append",
        status="success",
        message="已追加业务记录的加密证据版本。",
        patient_id=patient.id,
        actor_user_id=patient.user_id,
        detail_json={
            "record_id": record.id,
            "source_type": source_type,
            "source_record_id": source_record_id,
            "evidence_version": metadata_json["evidence_version"],
            "integrity_digest": record.integrity_digest,
            "audit_group": metadata_json["audit_group"],
        },
    )
    return record


def _extract_scale_dimensions(scale_result: ScaleResult) -> dict[str, int]:
    score_json = scale_result.score_json or {}
    radar_scores = score_json.get("radar_scores") or {}
    return {
        "total_score": int(round(float(scale_result.total_score or 0) * 10)),
        "risk_score": RISK_SCORE_MAP.get(scale_result.risk_level or "low", 100),
        "attention_control": int(
            round(float(radar_scores.get("attention_control", 0)) * 10)
        ),
        "hyperactivity": int(round(float(radar_scores.get("hyperactivity", 0)) * 10)),
    }


def _extract_tracking_dimensions(log: TrackingLog) -> dict[str, int]:
    try:
        mood_value = int(log.mood_tag or 0)
    except (TypeError, ValueError):
        mood_value = 0
    return {
        "mood_value": mood_value,
        "focus_minutes": int(log.focus_minutes or 0),
        "test_score_scaled": int(round(float(log.test_score or 0) * 100)),
    }


def _extract_cognitive_dimensions(record: CognitiveTest) -> dict[str, int]:
    payload = record.result_json or {}
    metrics = {
        **payload,
        **(payload.get("raw_result") or {}),
        **(payload.get("metrics") or {}),
    }

    def number(names):
        for name in names:
            value = metrics.get(name)
            if (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
            ):
                return float(value)
        return None

    accuracy = number(
        ["accuracy_pct", "accuracy_percent", "accuracy", "overall_accuracy"]
    )
    if accuracy is None:
        correct = number(["correct_trials", "correct_count", "correct"])
        total = number(["total_trials", "total_count", "total"])
        accuracy = (
            100 * correct / total
            if correct is not None and total and 0 <= correct <= total
            else 0
        )
    elif 0 <= accuracy <= 1 and not any(
        k in metrics for k in ("accuracy_pct", "accuracy_percent")
    ):
        accuracy *= 100
    latency = number(
        [
            "mean_rt_ms",
            "avg_rt_ms",
            "mean_reaction_time_ms",
            "average_reaction_time_ms",
            "reaction_time_ms",
            "average_reaction_time",
            "mean_rt",
            "avgReactionTime",
        ]
    )
    if latency is None:
        seconds = number(["mean_rt_seconds", "reaction_time_seconds"])
        latency = seconds * 1000 if seconds is not None else 0
    performance = number(["performance_score", "normalized_score", "score"])
    return {
        "performance_score": int(round(max(0, performance or 0))),
        "accuracy_score": int(round(max(0, min(100, accuracy)))),
        "latency_score": int(round(max(0, latency or 0))),
    }


def capture_scale_result_cipher(
    db: Session, patient: Patient, scale_result: ScaleResult
) -> SecurityCipherRecord | None:
    user_key = db.scalar(
        select(SecurityUserKey)
        .where(
            SecurityUserKey.patient_id == patient.id,
            SecurityUserKey.is_active.is_(True),
        )
        .order_by(SecurityUserKey.id.desc())
    )
    if user_key is None:
        user = db.get(User, patient.user_id)
        if user is None:
            return None
        user_key = provision_security_materials_for_user(db, user, auto_commit=False)
        if user_key is None:
            return None

    return _upsert_cipher_record(
        db,
        patient=patient,
        user_key=user_key,
        source_type="scale",
        source_record_id=scale_result.id,
        time_bucket=f"scale-{scale_result.id}",
        metadata_json={
            "scale_type": scale_result.scale_type,
            "created_at": scale_result.created_at.isoformat()
            if scale_result.created_at
            else None,
        },
        dimension_values=_extract_scale_dimensions(scale_result),
    )


def capture_tracking_log_cipher(
    db: Session, patient: Patient, log: TrackingLog
) -> SecurityCipherRecord | None:
    user_key = db.scalar(
        select(SecurityUserKey)
        .where(
            SecurityUserKey.patient_id == patient.id,
            SecurityUserKey.is_active.is_(True),
        )
        .order_by(SecurityUserKey.id.desc())
    )
    if user_key is None:
        user = db.get(User, patient.user_id)
        if user is None:
            return None
        user_key = provision_security_materials_for_user(db, user, auto_commit=False)
        if user_key is None:
            return None

    return _upsert_cipher_record(
        db,
        patient=patient,
        user_key=user_key,
        source_type="tracking",
        source_record_id=log.id,
        time_bucket=f"tracking-day-{log.day_index:02d}",
        metadata_json={
            "day_index": log.day_index,
            "created_at": log.created_at.isoformat() if log.created_at else None,
        },
        dimension_values=_extract_tracking_dimensions(log),
    )


def capture_cognitive_test_cipher(
    db: Session, patient: Patient, record: CognitiveTest
) -> SecurityCipherRecord | None:
    user_key = db.scalar(
        select(SecurityUserKey)
        .where(
            SecurityUserKey.patient_id == patient.id,
            SecurityUserKey.is_active.is_(True),
        )
        .order_by(SecurityUserKey.id.desc())
    )
    if user_key is None:
        user = db.get(User, patient.user_id)
        if user is None:
            return None
        user_key = provision_security_materials_for_user(db, user, auto_commit=False)
        if user_key is None:
            return None

    return _upsert_cipher_record(
        db,
        patient=patient,
        user_key=user_key,
        source_type="cognitive",
        source_record_id=record.id,
        time_bucket=f"cognitive-{record.id}",
        metadata_json={
            "test_type": record.test_type,
            "created_at": record.created_at.isoformat() if record.created_at else None,
        },
        dimension_values=_extract_cognitive_dimensions(record),
    )


def _backfill_existing_cipher_records(db: Session) -> None:
    captured = set(
        db.execute(
            select(
                SecurityCipherRecord.source_type, SecurityCipherRecord.source_record_id
            )
        ).all()
    )
    patients = db.scalars(select(Patient)).all()
    for patient in patients:
        scale_results = db.scalars(
            select(ScaleResult).where(ScaleResult.patient_id == patient.id)
        ).all()
        for item in scale_results:
            if ("scale", item.id) not in captured:
                capture_scale_result_cipher(db, patient, item)

        cognitive_tests = db.scalars(
            select(CognitiveTest).where(CognitiveTest.patient_id == patient.id)
        ).all()
        for item in cognitive_tests:
            if ("cognitive", item.id) not in captured:
                capture_cognitive_test_cipher(db, patient, item)

        tracking_logs = db.scalars(
            select(TrackingLog).where(TrackingLog.patient_id == patient.id)
        ).all()
        for item in tracking_logs:
            if ("tracking", item.id) not in captured:
                capture_tracking_log_cipher(db, patient, item)


def sync_security_runtime_entities(
    db: Session, *, actor_user_id: int | None = None
) -> None:
    patients = db.scalars(select(Patient)).all()
    for patient in patients:
        ensure_patient_security_assignment(db, patient, actor_user_id=actor_user_id)
    _backfill_existing_cipher_records(db)


def build_security_status(db: Session) -> dict[str, Any]:
    config = get_security_config(db)
    key_count = db.scalar(select(func.count(SecurityUserKey.id))) or 0
    cipher_count = db.scalar(select(func.count(SecurityCipherRecord.id))) or 0
    audit_count = db.scalar(select(func.count(SecurityAuditTask.id))) or 0
    mcs_node_count = db.scalar(select(func.count(SecurityMcsNode.id))) or 0
    assignment_count = db.scalar(select(func.count(SecurityPatientAssignment.id))) or 0

    return {
        "is_initialized": bool(config and config.is_initialized),
        "system_version": config.system_version if config else SECURITY_SCHEME_VERSION,
        "storage_mode": config.storage_mode if config else LOCAL_MCS_MODE,
        "public_params": config.public_params_json if config else {},
        "profiles": config.profile_params_json if config else {},
        "key_assignment_count": int(key_count),
        "mcs_node_count": int(mcs_node_count),
        "patient_assignment_count": int(assignment_count),
        "cipher_record_count": int(cipher_count),
        "audit_task_count": int(audit_count),
        "initialized_at": config.created_at.isoformat() if config else None,
        "updated_at": config.updated_at.isoformat() if config else None,
        "initialized_by_user_id": config.initialized_by_user_id if config else None,
    }


def list_key_assignments(db: Session, actor: User) -> list[dict[str, Any]]:
    assigned = db.scalars(
        select(SecurityPatientAssignment.patient_user_id).where(
            SecurityPatientAssignment.assigned_dac_user_id == actor.id,
            SecurityPatientAssignment.assignment_status == "active",
        )
    ).all()
    users = db.scalars(
        select(User)
        .where(User.id.in_([actor.id, *assigned]))
        .order_by(User.created_at.desc())
    ).all()
    items: list[dict[str, Any]] = []
    for user in users:
        key_record = db.scalar(
            select(SecurityUserKey)
            .where(
                SecurityUserKey.user_id == user.id, SecurityUserKey.is_active.is_(True)
            )
            .order_by(SecurityUserKey.id.desc())
        )
        patient = db.scalar(select(Patient).where(Patient.user_id == user.id))
        items.append(
            {
                "user_id": user.id,
                "full_name": patient_alias(patient.id)
                if patient
                else "DAC-" + str(user.id),
                "email": "身份信息已隔离",
                "staff_id": None,
                "role": user.role.value,
                "subrole": user.subrole.value if user.subrole else None,
                "patient_id": patient.id if patient else None,
                "key_fingerprint": key_record.key_fingerprint if key_record else None,
                "key_role": key_record.key_role if key_record else None,
                "is_active": bool(key_record and key_record.is_active),
                "created_at": key_record.created_at.isoformat() if key_record else None,
            }
        )
    return items


def list_mcs_nodes(db: Session) -> list[dict[str, Any]]:
    nodes = db.scalars(
        select(SecurityMcsNode).order_by(
            SecurityMcsNode.created_at.asc(), SecurityMcsNode.id.asc()
        )
    ).all()
    return [
        {
            "id": node.id,
            "node_code": node.node_code,
            "node_name": node.node_name,
            "storage_backend": node.storage_backend,
            "storage_namespace": node.storage_namespace,
            "is_active": node.is_active,
            "created_at": node.created_at.isoformat() if node.created_at else None,
        }
        for node in nodes
    ]


def list_patient_assignments(db: Session, actor: User) -> list[dict[str, Any]]:
    assignments = db.scalars(
        select(SecurityPatientAssignment)
        .where(SecurityPatientAssignment.assigned_dac_user_id == actor.id)
        .order_by(
            SecurityPatientAssignment.updated_at.desc(),
            SecurityPatientAssignment.id.desc(),
        )
    ).all()

    items: list[dict[str, Any]] = []
    for assignment in assignments:
        patient = db.get(Patient, assignment.patient_id)
        dac_user = (
            db.get(User, assignment.assigned_dac_user_id)
            if assignment.assigned_dac_user_id
            else None
        )
        mcs_node = (
            db.get(SecurityMcsNode, assignment.assigned_mcs_node_id)
            if assignment.assigned_mcs_node_id
            else None
        )
        items.append(
            {
                "id": assignment.id,
                "patient_id": assignment.patient_id,
                "patient_name": patient_alias(patient.id) if patient else None,
                "patient_user_id": assignment.patient_user_id,
                "assigned_dac_user_id": assignment.assigned_dac_user_id,
                "assigned_dac_name": "DAC-" + str(dac_user.id) if dac_user else None,
                "assigned_mcs_node_id": assignment.assigned_mcs_node_id,
                "assigned_mcs_node_code": mcs_node.node_code if mcs_node else None,
                "assignment_status": assignment.assignment_status,
                "assignment_version": assignment.assignment_version,
                "updated_at": assignment.updated_at.isoformat()
                if assignment.updated_at
                else None,
            }
        )
    return items


def build_patient_security_overview(db: Session, patient_id: int) -> dict[str, Any]:
    assignment = db.scalar(
        select(SecurityPatientAssignment).where(
            SecurityPatientAssignment.patient_id == patient_id
        )
    )
    patient = db.get(Patient, patient_id)
    dac_user = (
        db.get(User, assignment.assigned_dac_user_id)
        if assignment and assignment.assigned_dac_user_id
        else None
    )
    mcs_node = (
        db.get(SecurityMcsNode, assignment.assigned_mcs_node_id)
        if assignment and assignment.assigned_mcs_node_id
        else None
    )

    records = db.scalars(
        select(SecurityCipherRecord)
        .where(SecurityCipherRecord.patient_id == patient_id)
        .order_by(
            SecurityCipherRecord.created_at.desc(), SecurityCipherRecord.id.desc()
        )
    ).all()
    cipher_source_counts: dict[str, int] = {}
    audit_groups: dict[str, list[str]] = {}
    for record in records:
        cipher_source_counts[record.source_type] = (
            cipher_source_counts.get(record.source_type, 0) + 1
        )
        group = _audit_group_from_metadata(record.source_type, record.metadata_json)
        if group not in audit_groups.setdefault(record.source_type, []):
            audit_groups[record.source_type].append(group)

    latest_temporal_audit = db.scalar(
        select(SecurityAuditTask)
        .where(
            SecurityAuditTask.patient_id == patient_id,
            SecurityAuditTask.task_type == "temporal",
        )
        .order_by(SecurityAuditTask.created_at.desc(), SecurityAuditTask.id.desc())
    )

    if assignment is None:
        security_stage = "未纳入安全链路"
    elif not records:
        security_stage = "已分配待生成密文"
    elif latest_temporal_audit and latest_temporal_audit.verification_passed:
        security_stage = "已完成时间审计"
    elif latest_temporal_audit and latest_temporal_audit.verification_passed is False:
        security_stage = "时间审计未通过"
    else:
        security_stage = "已纳入安全链路"

    return {
        "patient_id": patient_id,
        "security_stage": security_stage,
        "assignment_status": assignment.assignment_status if assignment else None,
        "assigned_dac_user_id": assignment.assigned_dac_user_id if assignment else None,
        "assigned_dac_name": dac_user.full_name if dac_user else None,
        "assigned_mcs_node_id": assignment.assigned_mcs_node_id if assignment else None,
        "assigned_mcs_node_code": mcs_node.node_code if mcs_node else None,
        "assigned_mcs_node_name": mcs_node.node_name if mcs_node else None,
        "cipher_record_count": len(records),
        "has_cipher_records": bool(records),
        "cipher_source_counts": cipher_source_counts,
        "audit_groups": audit_groups,
        "latest_temporal_audit_id": latest_temporal_audit.id
        if latest_temporal_audit
        else None,
        "latest_temporal_audit_status": latest_temporal_audit.status
        if latest_temporal_audit
        else None,
        "latest_temporal_audit_passed": latest_temporal_audit.verification_passed
        if latest_temporal_audit
        else None,
        "latest_temporal_audit_source_type": latest_temporal_audit.source_type
        if latest_temporal_audit
        else None,
        "latest_temporal_audit_completed_at": latest_temporal_audit.completed_at.isoformat()
        if latest_temporal_audit and latest_temporal_audit.completed_at
        else None,
        "patient_name": patient_alias(patient.id) if patient else None,
    }


def list_patient_cipher_records(
    db: Session, patient_id: int, source_type: str | None = None
) -> list[dict[str, Any]]:
    stmt = (
        select(SecurityCipherRecord)
        .where(SecurityCipherRecord.patient_id == patient_id)
        .order_by(
            SecurityCipherRecord.created_at.desc(), SecurityCipherRecord.id.desc()
        )
    )
    if source_type:
        stmt = stmt.where(SecurityCipherRecord.source_type == source_type)
    records = db.scalars(stmt).all()

    return [
        {
            "id": record.id,
            "patient_id": record.patient_id,
            "source_type": record.source_type,
            "source_record_id": record.source_record_id,
            "patient_assignment_id": record.patient_assignment_id,
            "mcs_node_id": record.mcs_node_id,
            "time_bucket": record.time_bucket,
            "dimension_labels": record.dimension_labels_json,
            "metadata": record.metadata_json,
            "integrity_digest": record.integrity_digest,
            "cipher_version": record.cipher_version,
            "created_at": record.created_at.isoformat() if record.created_at else None,
        }
        for record in records
    ]


def list_recent_audits(
    db: Session, actor: User, limit: int = 12
) -> list[dict[str, Any]]:
    tasks = db.scalars(
        select(SecurityAuditTask)
        .where(SecurityAuditTask.requested_by_user_id == actor.id)
        .order_by(SecurityAuditTask.created_at.desc(), SecurityAuditTask.id.desc())
        .limit(limit)
    ).all()
    items: list[dict[str, Any]] = []
    for task in tasks:
        items.append(
            {
                "id": task.id,
                "patient_id": task.patient_id,
                "requested_by_user_id": task.requested_by_user_id,
                "patient_assignment_id": task.patient_assignment_id,
                "mcs_node_id": task.mcs_node_id,
                "task_type": task.task_type,
                "source_type": task.source_type,
                "status": task.status,
                "verification_passed": task.verification_passed,
                "verification_details": task.verification_details_json,
                "decrypted_stats": task.decrypted_stats_json,
                "created_at": task.created_at.isoformat() if task.created_at else None,
                "completed_at": task.completed_at.isoformat()
                if task.completed_at
                else None,
            }
        )
    return items


def list_recent_audit_logs(
    db: Session, actor: User, limit: int = 20
) -> list[dict[str, Any]]:
    logs = db.scalars(
        select(SecurityAuditLog)
        .where(
            (SecurityAuditLog.actor_user_id == actor.id)
            | SecurityAuditLog.patient_id.in_(
                select(SecurityPatientAssignment.patient_id).where(
                    SecurityPatientAssignment.assigned_dac_user_id == actor.id,
                    SecurityPatientAssignment.assignment_status == "active",
                )
            )
        )
        .order_by(SecurityAuditLog.created_at.desc(), SecurityAuditLog.id.desc())
        .limit(limit)
    ).all()
    return [
        {
            "id": log.id,
            "audit_task_id": log.audit_task_id,
            "patient_id": log.patient_id,
            "actor_user_id": log.actor_user_id,
            "action": log.action,
            "status": log.status,
            "message": log.message,
            "detail": log.detail_json,
            "previous_hash": log.previous_hash,
            "entry_hash": log.entry_hash,
            "created_at": log.created_at.isoformat() if log.created_at else None,
        }
        for log in logs
    ]


def run_temporal_audit(
    db: Session,
    *,
    patient_id: int,
    source_type: str,
    requester: User,
    audit_group: str | None = None,
) -> SecurityAuditTask:
    _assert_dac(requester)
    config = _ensure_system_ready(get_security_config(db))
    profile = _load_profile(config, source_type)
    paillier = _load_paillier_params(config)
    assignment = db.scalar(
        select(SecurityPatientAssignment).where(
            SecurityPatientAssignment.patient_id == patient_id,
            SecurityPatientAssignment.assignment_status == "active",
        )
    )
    if assignment is None:
        raise ValueError("No active Patient->DAC->MCS assignment found.")
    if assignment.assigned_dac_user_id != requester.id:
        raise ValueError("This patient is not assigned to the current DAC auditor.")
    if assignment.assigned_mcs_node_id is None:
        raise ValueError("This patient has no assigned local MCS node.")

    records = db.scalars(
        select(SecurityCipherRecord)
        .where(
            SecurityCipherRecord.patient_id == patient_id,
            SecurityCipherRecord.source_type == source_type,
            SecurityCipherRecord.mcs_node_id == assignment.assigned_mcs_node_id,
        )
        .order_by(SecurityCipherRecord.time_bucket.asc(), SecurityCipherRecord.id.asc())
    ).all()
    if not records:
        raise ValueError(
            "No encrypted records found for the selected patient and source type."
        )
    all_versions = _select_audit_group(records, audit_group)
    records = _latest_versions(all_versions)
    if len(records) > profile["max_records"]:
        raise ValueError("Too many records for configured aggregate bounds.")

    task = SecurityAuditTask(
        patient_id=patient_id,
        requested_by_user_id=requester.id,
        patient_assignment_id=assignment.id,
        mcs_node_id=assignment.assigned_mcs_node_id,
        task_type="temporal",
        source_type=source_type,
        status="aggregating",
        included_record_ids_json=[record.id for record in records],
        verification_details_json={"record_count": len(records)},
    )
    db.add(task)
    db.flush()

    _append_audit_log(
        db,
        action="temporal_audit_requested",
        status="success",
        message=f"DAC 已发起 {source_type} 时间聚合审计任务。",
        actor_user_id=requester.id,
        patient_id=patient_id,
        audit_task_id=task.id,
        detail_json={
            "record_count": len(records),
            "source_type": source_type,
            "mcs_node_id": assignment.assigned_mcs_node_id,
            "patient_assignment_id": assignment.id,
        },
    )

    nsquare = paillier["n"] * paillier["n"]
    aggregate_cipher = 1
    audit_secret = config.secret_params_json["audit_secret"]
    verification_issues: list[str] = _verify_evidence(db, all_versions, audit_secret)

    for record in records:
        expected_digest = _hmac_digest(
            audit_secret,
            _record_digest_payload(
                patient_id=record.patient_id,
                source_type=record.source_type,
                source_record_id=record.source_record_id,
                time_bucket=record.time_bucket,
                encrypted_payload=record.encrypted_payload,
                key_fingerprint=record.key_fingerprint,
                metadata_json=record.metadata_json,
            ),
        )
        if expected_digest != record.integrity_digest:
            verification_issues.append(f"Record {record.id} integrity digest mismatch.")
        try:
            aggregate_cipher = (
                aggregate_cipher * int(record.encrypted_payload)
            ) % nsquare
        except (ValueError, TypeError):
            verification_issues.append(f"Record {record.id}: invalid ciphertext.")

    task.aggregate_ciphertext = str(aggregate_cipher)
    task.aggregate_digest = _hmac_digest(
        audit_secret,
        {
            "patient_id": patient_id,
            "mcs_node_id": assignment.assigned_mcs_node_id,
            "source_type": source_type,
            "record_ids": [record.id for record in records],
            "aggregate_ciphertext": task.aggregate_ciphertext,
        },
    )
    task.status = "verifying"
    db.flush()

    recomputed_cipher = 1
    for record in records:
        try:
            recomputed_cipher = (
                recomputed_cipher * int(record.encrypted_payload)
            ) % nsquare
        except (ValueError, TypeError):
            pass

    verification_passed = (
        not verification_issues and recomputed_cipher == aggregate_cipher
    )
    if recomputed_cipher != aggregate_cipher:
        verification_issues.append(
            "Aggregate ciphertext mismatch during DAC recomputation."
        )

    packed_total = _decrypt_with_paillier(
        paillier["n"],
        paillier["lambda"],
        paillier["mu"],
        aggregate_cipher,
    )
    decrypted_stats = (
        _unpack_aggregate(profile, packed_total, len(records))
        if verification_passed
        else {}
    )

    task.verification_passed = verification_passed
    task.verification_details_json = {
        "record_count": len(records),
        "verified_record_ids": [record.id for record in records]
        if verification_passed
        else [],
        "checked_record_ids": [record.id for record in records],
        "issues": verification_issues,
        "integrity_verified": not verification_issues,
        "source_binding_verified": not verification_issues,
        "historical_evidence_count": len(all_versions),
        "audit_group": _audit_group_from_metadata(
            source_type, records[0].metadata_json
        ),
        "aggregate_verified": recomputed_cipher == aggregate_cipher,
        "mcs_node_id": assignment.assigned_mcs_node_id,
    }
    task.decrypted_stats_json = {
        "source_type": source_type,
        "mcs_node_id": assignment.assigned_mcs_node_id,
        "record_count": len(records),
        "time_buckets": [record.time_bucket for record in records],
        "stats": decrypted_stats,
        "audit_group": _audit_group_from_metadata(
            source_type, records[0].metadata_json
        ),
    }
    task.status = "completed" if verification_passed else "failed"
    task.completed_at = _utcnow()

    _append_audit_log(
        db,
        action="temporal_audit_completed",
        status="success" if verification_passed else "failed",
        message=(
            f"{source_type} 时间聚合审计已完成。"
            if verification_passed
            else f"{source_type} 时间聚合审计失败。"
        ),
        actor_user_id=requester.id,
        patient_id=patient_id,
        audit_task_id=task.id,
        detail_json=task.verification_details_json,
    )

    db.commit()
    db.refresh(task)
    return task


def run_spatial_audit(
    db: Session,
    *,
    patient_ids: list[int],
    source_type: str,
    requester: User,
    audit_group: str | None = None,
) -> SecurityAuditTask:
    _assert_dac(requester)
    config = _ensure_system_ready(get_security_config(db))
    profile = _load_profile(config, source_type)
    paillier = _load_paillier_params(config)

    selected_patient_ids: list[int] = []
    assignments: list[SecurityPatientAssignment] = []
    for patient_id in patient_ids:
        patient_id = int(patient_id)
        if patient_id in selected_patient_ids:
            continue
        assignment = db.scalar(
            select(SecurityPatientAssignment).where(
                SecurityPatientAssignment.patient_id == patient_id,
                SecurityPatientAssignment.assignment_status == "active",
            )
        )
        if assignment is None:
            raise ValueError(f"Patient {patient_id} has no active DAC/MCS assignment.")
        if assignment.assigned_dac_user_id != requester.id:
            raise ValueError(
                f"Patient {patient_id} is not assigned to the current DAC auditor."
            )
        if assignment.assigned_mcs_node_id is None:
            raise ValueError(f"Patient {patient_id} has no assigned local MCS node.")
        selected_patient_ids.append(patient_id)
        assignments.append(assignment)

    if not selected_patient_ids:
        raise ValueError("No patients selected for spatial aggregation audit.")

    mcs_node_id = assignments[0].assigned_mcs_node_id
    if any(
        assignment.assigned_mcs_node_id != mcs_node_id for assignment in assignments
    ):
        raise ValueError(
            "All selected patients must be routed to the same local MCS node."
        )

    if len(selected_patient_ids) < 2:
        raise ValueError("Spatial audit requires at least two authorized patients.")
    all_versions = db.scalars(
        select(SecurityCipherRecord).where(
            SecurityCipherRecord.patient_id.in_(selected_patient_ids),
            SecurityCipherRecord.source_type == source_type,
            SecurityCipherRecord.mcs_node_id == mcs_node_id,
        )
    ).all()
    all_versions = _select_audit_group(all_versions, audit_group)
    current = _latest_versions(all_versions)
    by_patient = {}
    for record in sorted(current, key=lambda r: r.id):
        by_patient[record.patient_id] = record
    records = [by_patient[i] for i in selected_patient_ids if i in by_patient]
    missing_patient_ids = [i for i in selected_patient_ids if i not in by_patient]
    if len(records) < 2:
        raise ValueError(
            "At least two patients need records in the selected audit group."
        )
    if len(records) > profile["max_records"]:
        raise ValueError("Too many records for configured aggregate bounds.")

    task = SecurityAuditTask(
        patient_id=selected_patient_ids[0],
        requested_by_user_id=requester.id,
        patient_assignment_id=assignments[0].id,
        mcs_node_id=mcs_node_id,
        task_type="spatial",
        source_type=source_type,
        status="aggregating",
        included_record_ids_json=[record.id for record in records],
        verification_details_json={
            "selected_patient_ids": selected_patient_ids,
            "missing_patient_ids": missing_patient_ids,
            "record_count": len(records),
        },
    )
    db.add(task)
    db.flush()

    _append_audit_log(
        db,
        action="spatial_audit_requested",
        status="success",
        message=f"DAC 已发起 {source_type} 空间聚合审计任务。",
        actor_user_id=requester.id,
        patient_id=selected_patient_ids[0],
        audit_task_id=task.id,
        detail_json={
            "selected_patient_ids": selected_patient_ids,
            "missing_patient_ids": missing_patient_ids,
            "record_count": len(records),
            "mcs_node_id": mcs_node_id,
        },
    )

    nsquare = paillier["n"] * paillier["n"]
    aggregate_cipher = 1
    audit_secret = config.secret_params_json["audit_secret"]
    verification_issues: list[str] = _verify_evidence(db, all_versions, audit_secret)

    for record in records:
        expected_digest = _hmac_digest(
            audit_secret,
            _record_digest_payload(
                patient_id=record.patient_id,
                source_type=record.source_type,
                source_record_id=record.source_record_id,
                time_bucket=record.time_bucket,
                encrypted_payload=record.encrypted_payload,
                key_fingerprint=record.key_fingerprint,
                metadata_json=record.metadata_json,
            ),
        )
        if expected_digest != record.integrity_digest:
            verification_issues.append(f"Record {record.id} integrity digest mismatch.")
        try:
            aggregate_cipher = (
                aggregate_cipher * int(record.encrypted_payload)
            ) % nsquare
        except (ValueError, TypeError):
            verification_issues.append(f"Record {record.id}: invalid ciphertext.")

    task.aggregate_ciphertext = str(aggregate_cipher)
    task.aggregate_digest = _hmac_digest(
        audit_secret,
        {
            "patient_group": selected_patient_ids,
            "mcs_node_id": mcs_node_id,
            "source_type": source_type,
            "record_ids": [record.id for record in records],
            "aggregate_ciphertext": task.aggregate_ciphertext,
        },
    )
    task.status = "verifying"
    db.flush()

    recomputed_cipher = 1
    for record in records:
        try:
            recomputed_cipher = (
                recomputed_cipher * int(record.encrypted_payload)
            ) % nsquare
        except (ValueError, TypeError):
            pass

    verification_passed = (
        not verification_issues and recomputed_cipher == aggregate_cipher
    )
    if recomputed_cipher != aggregate_cipher:
        verification_issues.append(
            "Aggregate ciphertext mismatch during DAC recomputation."
        )

    packed_total = _decrypt_with_paillier(
        paillier["n"],
        paillier["lambda"],
        paillier["mu"],
        aggregate_cipher,
    )
    decrypted_stats = (
        _unpack_aggregate(profile, packed_total, len(records))
        if verification_passed
        else {}
    )

    task.verification_passed = verification_passed
    task.verification_details_json = {
        "selected_patient_ids": selected_patient_ids,
        "missing_patient_ids": missing_patient_ids,
        "record_count": len(records),
        "verified_record_ids": [record.id for record in records]
        if verification_passed
        else [],
        "checked_record_ids": [record.id for record in records],
        "issues": verification_issues,
        "integrity_verified": not verification_issues,
        "source_binding_verified": not verification_issues,
        "historical_evidence_count": len(all_versions),
        "audit_group": _audit_group_from_metadata(
            source_type, records[0].metadata_json
        ),
        "aggregate_verified": recomputed_cipher == aggregate_cipher,
        "mcs_node_id": mcs_node_id,
    }
    task.decrypted_stats_json = {
        "source_type": source_type,
        "aggregation_scope": "spatial_latest_per_patient",
        "aggregated_patient_ids": [record.patient_id for record in records],
        "missing_patient_ids": missing_patient_ids,
        "record_count": len(records),
        "mcs_node_id": mcs_node_id,
        "stats": decrypted_stats,
        "audit_group": _audit_group_from_metadata(
            source_type, records[0].metadata_json
        ),
    }
    task.status = "completed" if verification_passed else "failed"
    task.completed_at = _utcnow()

    _append_audit_log(
        db,
        action="spatial_audit_completed",
        status="success" if verification_passed else "failed",
        message=(
            f"{source_type} 空间聚合审计已完成。"
            if verification_passed
            else f"{source_type} 空间聚合审计失败。"
        ),
        actor_user_id=requester.id,
        patient_id=selected_patient_ids[0],
        audit_task_id=task.id,
        detail_json=task.verification_details_json,
    )

    db.commit()
    db.refresh(task)
    return task


def _chain_tag(log_id, last_hash: str) -> str:
    return hmac.new(
        scoped_key("audit-log"),
        _json_dumps({"log_id": log_id, "last_hash": last_hash}).encode(),
        hashlib.sha256,
    ).hexdigest()


def _log_hash(log: SecurityAuditLog) -> str:
    timestamp = log.created_at.replace(tzinfo=timezone.utc).isoformat()
    payload = {
        "id": log.id,
        "previous_hash": log.previous_hash,
        "task": log.audit_task_id,
        "patient": log.patient_id,
        "actor": log.actor_user_id,
        "action": log.action,
        "status": log.status,
        "message": log.message,
        "detail": log.detail_json,
        "created_at": timestamp,
    }
    return hmac.new(
        scoped_key("audit-log"), _json_dumps(payload).encode(), hashlib.sha256
    ).hexdigest()


def verify_audit_log_chain(db: Session) -> dict[str, Any]:
    logs = db.scalars(select(SecurityAuditLog).order_by(SecurityAuditLog.id)).all()
    previous = "GENESIS"
    issues = []
    legacy = []
    last_id = None
    for log in logs:
        if not log.entry_hash:
            legacy.append(log.id)
            continue
        if log.previous_hash != previous or not hmac.compare_digest(
            log.entry_hash, _log_hash(log)
        ):
            issues.append(log.id)
        previous = log.entry_hash
        last_id = log.id
    head = db.get(SecurityLogChainHead, 1)
    config = get_security_config(db)
    initialized_v2 = bool(config and config.is_initialized)
    head_valid = (head is None and last_id is None and not initialized_v2) or (
        head is not None
        and head.last_log_id == last_id
        and head.last_hash == previous
        and hmac.compare_digest(
            head.state_tag, _chain_tag(head.last_log_id, head.last_hash)
        )
    )
    return {
        "verified": not issues and head_valid,
        "checked_records": len(logs) - len(legacy),
        "invalid_record_ids": issues,
        "legacy_unprotected_ids": legacy,
        "head_verified": head_valid,
    }


def patient_alias(patient_id: int) -> str:
    alias = (
        hmac.new(scoped_key("patient-alias"), str(patient_id).encode(), hashlib.sha256)
        .hexdigest()[:12]
        .upper()
    )
    return "P-" + alias


def _source_record(db: Session, source_type: str, source_id: int):
    model = {"scale": ScaleResult, "cognitive": CognitiveTest, "tracking": TrackingLog}[
        source_type
    ]
    return db.get(model, source_id, populate_existing=True)


def _source_digest(source) -> str:
    if source is None:
        return ""
    from sqlalchemy import inspect as orm_inspect

    payload = {}
    for column in orm_inspect(type(source)).columns:
        value = getattr(source, column.name)
        if isinstance(value, datetime):
            value = value.replace(tzinfo=timezone.utc).isoformat()
        payload[column.name] = value
    return _hash_text(_json_dumps(payload))


def _latest_versions(records):
    latest = {}
    for record in records:
        key = (record.patient_id, record.source_type, record.source_record_id)
        if key not in latest or record.id > latest[key].id:
            latest[key] = record
    return sorted(latest.values(), key=lambda r: (r.time_bucket, r.id))


def _verify_evidence(db: Session, records, audit_secret: str) -> list[str]:
    issues = []
    chain = verify_audit_log_chain(db)
    if not chain["verified"]:
        issues.append("Audit log chain integrity failed.")
    patient_ids = {r.patient_id for r in records}
    source_types = {r.source_type for r in records}
    manifest = db.scalars(
        select(SecurityAuditLog).where(
            SecurityAuditLog.action == "evidence_append",
            SecurityAuditLog.patient_id.in_(patient_ids),
        )
    ).all()
    for entry in manifest:
        detail = entry.detail_json or {}
        if not entry.entry_hash or detail.get("source_type") not in source_types:
            continue
        saved = db.get(SecurityCipherRecord, detail.get("record_id"))
        if saved is None:
            issues.append(f"Evidence append {entry.id}: referenced record missing.")
        elif (
            saved.patient_id != entry.patient_id
            or saved.source_type != detail.get("source_type")
            or (saved.metadata_json or {}).get("evidence_version")
            != detail.get("evidence_version")
            or (
                detail.get("integrity_digest")
                and not hmac.compare_digest(
                    saved.integrity_digest, detail["integrity_digest"]
                )
            )
        ):
            issues.append(f"Evidence append {entry.id}: history anchor mismatch.")
    latest_ids = {r.id for r in _latest_versions(records)}
    by_id = {r.id: r for r in records}
    for record in records:
        metadata = record.metadata_json or {}
        expected = _hmac_digest(
            audit_secret,
            _record_digest_payload(
                patient_id=record.patient_id,
                source_type=record.source_type,
                source_record_id=record.source_record_id,
                time_bucket=record.time_bucket,
                encrypted_payload=record.encrypted_payload,
                key_fingerprint=record.key_fingerprint,
                metadata_json=metadata,
            ),
        )
        if not hmac.compare_digest(expected, record.integrity_digest):
            issues.append(f"Record {record.id}: digest mismatch.")
        if not metadata.get("source_digest"):
            issues.append(f"Record {record.id}: legacy evidence has no source binding.")
            continue
        if (
            metadata.get("patient_assignment_id") != record.patient_assignment_id
            or metadata.get("mcs_node_id") != record.mcs_node_id
            or metadata.get("dimension_labels") != record.dimension_labels_json
            or metadata.get("cipher_version") != record.cipher_version
        ):
            issues.append(f"Record {record.id}: evidence context mismatch.")
        previous_id = metadata.get("supersedes_record_id")
        if previous_id:
            previous = by_id.get(previous_id)
            if (
                not previous
                or metadata.get("previous_integrity_digest")
                != previous.integrity_digest
            ):
                issues.append(f"Record {record.id}: evidence history mismatch.")
        try:
            number = int(record.encrypted_payload)
            if number <= 0:
                raise ValueError()
        except (ValueError, TypeError):
            issues.append(f"Record {record.id}: invalid ciphertext.")
        if record.id in latest_ids:
            try:
                source = _source_record(db, record.source_type, record.source_record_id)
            except Exception:
                issues.append(f"Record {record.id}: source authentication failed.")
                continue
            if (
                source is None
                or source.patient_id != record.patient_id
                or _source_digest(source) != metadata["source_digest"]
            ):
                issues.append(f"Record {record.id}: source changed or missing.")
    return issues


def _assert_dac(requester: User) -> None:
    if requester.role != UserRole.RESEARCHER or requester.subrole != UserSubrole.DAC:
        raise ValueError("DAC permission required.")


def _audit_group_from_metadata(source_type: str, metadata: dict) -> str:
    if source_type == "scale":
        return "scale:" + str(metadata.get("scale_type", "unknown"))
    if source_type == "cognitive":
        return (
            "cognitive:"
            + str(
                metadata.get(
                    "canonical_test_type", metadata.get("test_type", "unknown")
                )
            )
            + "|"
            + str(metadata.get("protocol_key", "unknown|legacy-unversioned|0|unknown"))
        )
    return "tracking:v1"


def _select_audit_group(records, audit_group):
    groups = {
        _audit_group_from_metadata(r.source_type, r.metadata_json) for r in records
    }
    if not records:
        raise ValueError("No encrypted records in the selected audit group.")
    if audit_group is None:
        if len(groups) > 1:
            raise ValueError(
                "Multiple scales or cognitive protocols found. Select one audit group before aggregation."
            )
        return records
    selected = [
        r
        for r in records
        if _audit_group_from_metadata(r.source_type, r.metadata_json) == audit_group
    ]
    if not selected:
        raise ValueError("No encrypted records in the selected audit group.")
    return selected


def _ensure_log_chain_head(db: Session) -> None:
    if db.get(SecurityLogChainHead, 1) is not None:
        return
    config = get_security_config(db)
    protected = db.scalar(
        select(SecurityAuditLog.id)
        .where(SecurityAuditLog.entry_hash.is_not(None))
        .limit(1)
    )
    if protected is not None or (config and config.is_initialized):
        raise ValueError(
            "Audit chain anchor is missing. Restore the backed-up anchor; do not silently create a new chain."
        )
    db.add(
        SecurityLogChainHead(
            id=1, last_hash="GENESIS", state_tag=_chain_tag(None, "GENESIS")
        )
    )
    db.flush()


def migrate_legacy_audit_anchor(db: Session) -> None:
    """Establish an explicit baseline only for pre-chain, authenticated legacy configuration."""
    config = get_security_config(db)
    if not config or not config.is_initialized:
        return
    secrets_json = config.secret_params_json or {}
    if db.get(SecurityLogChainHead, 1) is not None:
        if not secrets_json.get("audit_log_chain_version") or not secrets_json.get(
            "public_config_digest"
        ):
            config.secret_params_json = {
                **secrets_json,
                "audit_log_chain_version": 1,
                "public_config_digest": _security_config_digest(config),
            }
            db.flush()
        return
    protected = db.scalar(
        select(SecurityAuditLog.id)
        .where(SecurityAuditLog.entry_hash.is_not(None))
        .limit(1)
    )
    v2_evidence = db.scalar(
        select(SecurityCipherRecord.id)
        .where(SecurityCipherRecord.cipher_version == SECURITY_SCHEME_VERSION)
        .limit(1)
    )
    if (
        secrets_json.get("audit_log_chain_version")
        or protected is not None
        or v2_evidence is not None
    ):
        raise ValueError(
            "Protected audit anchor is missing; restore it instead of resetting history."
        )
    config.secret_params_json = {
        **secrets_json,
        "audit_log_chain_version": 1,
        "public_config_digest": _security_config_digest(config),
    }
    db.add(
        SecurityLogChainHead(
            id=1, last_hash="GENESIS", state_tag=_chain_tag(None, "GENESIS")
        )
    )
    db.flush()
    _append_audit_log(
        db,
        action="legacy_log_baseline",
        status="success",
        message="旧日志保留为历史资料，认证链从本次迁移开始。",
        detail_json={
            "legacy_unprotected_count": db.scalar(
                select(func.count(SecurityAuditLog.id)).where(
                    SecurityAuditLog.entry_hash.is_(None)
                )
            )
            or 0
        },
    )


def _security_config_digest(config: SecuritySystemConfig) -> str:
    payload = {
        "id": config.id,
        "system_version": config.system_version,
        "storage_mode": config.storage_mode,
        "public_params": config.public_params_json,
        "profiles": config.profile_params_json,
    }
    return hmac.new(
        scoped_key("security-config"), _json_dumps(payload).encode(), hashlib.sha256
    ).hexdigest()
