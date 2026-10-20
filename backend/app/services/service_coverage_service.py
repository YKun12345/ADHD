"""Institutional coverage facts and working-time computation, no implicit approval."""
import base64
import hashlib
import hmac
import json
from functools import wraps
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import DBAPIError, IntegrityError

from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.core.config import settings
from backend.app.models.identity import InstitutionMembership
from backend.app.models.service_coverage import ServiceCoverageVersion
from backend.app.models.user import User
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.identity_access import (active_memberships, record_authority, recheck_authorities,
    recheck_authenticated_actor, require_doctor, require_reviewer)


def _storage_boundary(handler):
    @wraps(handler)
    def invoke(*args, **kwargs):
        try:
            return handler(*args, **kwargs)
        except DBAPIError as exc:
            raise HTTPException(503, "Coverage storage is unavailable; no configuration or submission is confirmed.") from exc
    return invoke


def utc(value):
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def working_deadline(start, periods, minutes):
    """Consume actual configured working minutes; weekends/lunch are not work."""
    cursor = utc(start).astimezone(ZoneInfo("Asia/Shanghai"))
    periods = sorted(periods, key=lambda value: (value["weekday"], value["start"]))
    remaining = timedelta(minutes=minutes)
    weekly = sum((datetime.combine(cursor.date(), time.fromisoformat(value["end"])) -
        datetime.combine(cursor.date(), time.fromisoformat(value["start"])) for value in periods), timedelta())
    if remaining <= timedelta() or weekly <= timedelta():
        raise ValueError("A positive actual working window is required.")
    while True:
        if cursor.weekday() == 0 and cursor.timetz().replace(tzinfo=None) == time.min and remaining > weekly:
            # Keep an exact boundary in its final working period, not next week.
            weeks = int((remaining - timedelta(microseconds=1)) // weekly)
            cursor += timedelta(weeks=weeks)
            remaining -= weeks * weekly
        for value in periods:
            if value["weekday"] != cursor.weekday():
                continue
            beginning = datetime.combine(cursor.date(), time.fromisoformat(value["start"]), cursor.tzinfo)
            end = datetime.combine(cursor.date(), time.fromisoformat(value["end"]), cursor.tzinfo)
            beginning = max(beginning, cursor)
            if end <= beginning:
                continue
            if remaining <= end - beginning:
                return (beginning + remaining).astimezone(timezone.utc)
            remaining -= end - beginning
        cursor = datetime.combine(cursor.date() + timedelta(days=1), time.min, cursor.tzinfo)


def _audit(db, user, action, **detail):
    from backend.app.services.security_service import _append_audit_log
    try:
        _append_audit_log(db, action=action, status="success", actor_user_id=user.id,
            message="机构服务覆盖实际配置及版本已核对。", detail_json=detail)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Critical institutional coverage audit is unavailable.") from exc


def _metadata(row):
    return {"id": row.id, "client_coverage_id": row.client_coverage_id, "institution_id": row.institution_id,
        "doctor_user_id": row.doctor_user_id, "reviewer_user_id": row.reviewer_user_id, "version": row.version,
        "effective_from": utc(row.effective_from).isoformat(), "payload_digest": row.payload_digest}


def coverage_response(row):
    value = row.config
    if not isinstance(value, dict) or value.get("metadata") != _metadata(row):
        raise RecordIntegrityError("Institutional coverage routing differs from its authenticated original.")
    return {**_metadata(row), **value["settings"], "submission_status": "committed", "legacy": False,
        "configuration_context_digest": value.get("configuration_context_digest"),
        "institutional_admission_status": "not_verified_by_configuration"}


def _doctor_institution(db, identifier, institution):
    qualification = require_doctor(db, identifier)
    if qualification.institution_id != institution:
        raise HTTPException(403, "Coverage requires the doctor's actual verified institution.")
    return qualification


def _credential_snapshot(db):
    return [[*receipt[:5], utc(receipt[5]).isoformat() if receipt[5] else None, receipt[6]]
        for receipt in db.info.get("credential_receipts", [])]


def _check_original_credentials(db, row):
    value = row.config
    coverage_response(row)
    try:
        receipts = [tuple([*receipt[:5], datetime.fromisoformat(receipt[5]) if receipt[5] else None, receipt[6]])
            for receipt in value["credential_snapshot"]]
    except (TypeError, ValueError, KeyError, IndexError) as exc:
        raise RecordIntegrityError("Coverage authority snapshot is malformed.") from exc
    recheck_authorities(db, receipts)
    for receipt in receipts:
        if receipt not in db.info.setdefault("credential_receipts", []):
            db.info["credential_receipts"].append(receipt)
    request = db.info.get("authorization_request")
    if request is not None:
        request.state.credential_receipts = db.info["credential_receipts"]


def _context_key():
    return hmac.new(settings.SECRET_KEY.encode(), b"adhd-ab/institutional-coverage/context/v1", hashlib.sha256).digest()


def _issue_context(db, user, doctor_id, institution, previous):
    body = {"purpose": "service_coverage", "actor_user_id": user.id, "doctor_user_id": doctor_id,
        "institution_id": institution, "expected_previous_version": previous, "credential_snapshot": _credential_snapshot(db)}
    encoded = base64.urlsafe_b64encode(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).decode().rstrip("=")
    return "service-coverage-context.v1." + encoded + "." + hmac.new(_context_key(), encoded.encode(), hashlib.sha256).hexdigest()


def _check_context(db, user, doctor_id, payload):
    if payload.configuration_context is None:
        return  # Direct online institutional clients act under this actual request's credentials.
    try:
        prefix, version, encoded, signature = payload.configuration_context.split(".")
        if prefix != "service-coverage-context" or version != "v1" or not hmac.compare_digest(signature,
                hmac.new(_context_key(), encoded.encode(), hashlib.sha256).hexdigest()):
            raise ValueError("signature")
        value = json.loads(base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True))
        if (value["purpose"], value["actor_user_id"], value["doctor_user_id"], value["institution_id"], value["expected_previous_version"]) != (
                "service_coverage", user.id, doctor_id, payload.institution_id, payload.expected_previous_version):
            raise ValueError("scope")
        receipts = [tuple([*receipt[:5], datetime.fromisoformat(receipt[5]) if receipt[5] else None, receipt[6]]) for receipt in value["credential_snapshot"]]
        if not receipts:
            raise ValueError("missing original authority")
    except (TypeError, KeyError, ValueError, UnicodeError, IndexError) as exc:
        raise HTTPException(403, "The original institutional configuration context is invalid.") from exc
    recheck_authorities(db, receipts)
    for receipt in receipts:
        if receipt not in db.info.setdefault("credential_receipts", []):
            db.info["credential_receipts"].append(receipt)


@_storage_boundary
def create_coverage(db, user, doctor_id, payload):
    recheck_authenticated_actor(db, user.id)
    require_reviewer(db, user.id, payload.institution_id)
    _doctor_institution(db, doctor_id, payload.institution_id)
    _check_context(db, user, doctor_id, payload)
    # Serialize first creation too: SQLite ignores FOR UPDATE; real doctor row exists.
    db.execute(update(User).where(User.id == doctor_id).values(is_active=User.is_active)
        .execution_options(synchronize_session=False))
    digest = canonical_digest(payload.model_dump())
    existing = db.scalar(select(ServiceCoverageVersion).where(ServiceCoverageVersion.client_coverage_id == payload.client_coverage_id))
    if existing:
        value = coverage_response(existing)
        if (existing.reviewer_user_id, existing.doctor_user_id, existing.institution_id, existing.payload_digest) != (
                user.id, doctor_id, payload.institution_id, digest):
            raise HTTPException(409, "This original coverage ID has different immutable actor, scope or settings.")
        _check_original_credentials(db, existing)
        _audit(db, user, "service_coverage_original_ack_read", coverage_id=existing.id)
        return value, False
    current = db.scalar(select(ServiceCoverageVersion).where(ServiceCoverageVersion.doctor_user_id == doctor_id,
        ServiceCoverageVersion.institution_id == payload.institution_id).order_by(ServiceCoverageVersion.version.desc()).with_for_update())
    if current:
        coverage_response(current)
    previous = current.version if current else 0
    if previous != payload.expected_previous_version:
        raise HTTPException(409, "Coverage changed; reload the actual previous version before confirming.")
    row = ServiceCoverageVersion(client_coverage_id=payload.client_coverage_id, institution_id=payload.institution_id,
        doctor_user_id=doctor_id, reviewer_user_id=user.id, version=previous + 1, effective_from=datetime.now(timezone.utc),
        payload_digest=digest, config={})
    db.add(row)
    try:
        db.flush()
        from backend.app.core.record_envelope import seal_record
        from sqlalchemy.orm.attributes import set_committed_value
        configuration = payload.model_dump(exclude={"client_coverage_id", "expected_previous_version", "institution_id", "configuration_context"})
        original = {"metadata": _metadata(row), "settings": configuration, "credential_snapshot": _credential_snapshot(db),
            "configuration_context_digest": canonical_digest(payload.configuration_context) if payload.configuration_context else None}
        cipher = seal_record(original, row._binding("config"))
        db.execute(update(ServiceCoverageVersion).where(ServiceCoverageVersion.id == row.id).values(_config_cipher=cipher)
            .execution_options(synchronize_session=False))
        set_committed_value(row, "_config_cipher", cipher)
        _audit(db, user, "service_coverage_version_recorded", coverage_id=row.id, institution_id=row.institution_id,
            doctor_user_id=doctor_id, version=row.version, payload_digest=digest)
    except IntegrityError as exc:
        raise HTTPException(409, "Concurrent coverage creation requires original-ID query or unchanged retry.") from exc
    return coverage_response(row), True


@_storage_boundary
def coverage_versions(db, user, doctor_id, institution):
    recheck_authenticated_actor(db, user.id)
    require_reviewer(db, user.id, institution)
    _doctor_institution(db, doctor_id, institution)
    rows = db.scalars(select(ServiceCoverageVersion).where(ServiceCoverageVersion.institution_id == institution,
        ServiceCoverageVersion.doctor_user_id == doctor_id).order_by(ServiceCoverageVersion.version)).all()
    values = [coverage_response(row) for row in rows]
    _audit(db, user, "service_coverage_versions_read", institution_id=institution, doctor_user_id=doctor_id)
    token = _issue_context(db, user, doctor_id, institution, rows[-1].version if rows else 0)
    return {"items": values, "configuration_context": token, "configuration_context_digest": canonical_digest(token)}


@_storage_boundary
def original_coverage(db, user, client_id):
    row = db.scalar(select(ServiceCoverageVersion).where(ServiceCoverageVersion.client_coverage_id == client_id))
    if row is None:
        raise HTTPException(404, "Original institutional coverage submission not found.")
    value = coverage_response(row)
    if row.reviewer_user_id != user.id:
        raise HTTPException(403, "Only the actual original reviewer may recover this configuration ACK.")
    require_reviewer(db, user.id, row.institution_id)
    _doctor_institution(db, row.doctor_user_id, row.institution_id)
    _check_original_credentials(db, row)
    _audit(db, user, "service_coverage_original_ack_read", coverage_id=row.id)
    return value


def unknown_coverage(reason="not_configured"):
    return {"status": "not_configured", "reason": reason, "emergency_process": "not_configured",
        "working_periods": None, "expected_response_at": None, "coverage": None,
        "institutional_admission_status": "not_verified_by_configuration"}


@_storage_boundary
def current_coverage(db, doctor_id, *, at=None):
    previous = list(db.info.get("credential_receipts", []))
    try:
        qualification = require_doctor(db, doctor_id)
        at = utc(at or datetime.now(timezone.utc))
        row = db.scalar(select(ServiceCoverageVersion).where(ServiceCoverageVersion.doctor_user_id == doctor_id,
            ServiceCoverageVersion.institution_id == qualification.institution_id,
            ServiceCoverageVersion.effective_from <= at).order_by(ServiceCoverageVersion.version.desc()))
        if row is None:
            return unknown_coverage()
        _check_original_credentials(db, row)
        value = coverage_response(row)
        return {"status": "configured", "coverage": value, "working_periods": value["working_periods"],
            "emergency_process": "recorded_institutional_instructions", "expected_response_at": None,
            "institutional_admission_status": "not_verified_by_configuration"}
    except HTTPException as exc:
        if exc.status_code != 403:
            raise
        db.info["credential_receipts"] = previous
        request = db.info.get("authorization_request")
        if request is not None:
            request.state.credential_receipts = previous
        return unknown_coverage("coverage_authority_changed")


@_storage_boundary
def doctor_coverage(db, user):
    require_doctor(db, user.id)
    value = current_coverage(db, user.id)
    _audit(db, user, "service_coverage_current_read", doctor_user_id=user.id)
    return value


@_storage_boundary
def reviewer_doctors(db, user):
    recheck_authenticated_actor(db, user.id)
    memberships = active_memberships(db, user.id, "reviewer")
    if not memberships:
        raise HTTPException(403, "Verified institutional reviewer access is required.")
    items = []
    for membership in memberships:
        record_authority(db, membership)
        identifiers = db.scalars(select(InstitutionMembership.user_id).where(InstitutionMembership.institution_id == membership.institution_id,
            InstitutionMembership.role == "clinician", InstitutionMembership.status == "verified")).all()
        for identifier in sorted(set(identifiers)):
            try:
                _doctor_institution(db, identifier, membership.institution_id)
            except HTTPException as exc:
                if exc.status_code == 403:
                    continue
                raise
            items.append({"doctor_user_id": identifier, "institution_id": membership.institution_id})
    _audit(db, user, "service_coverage_reviewable_doctors_read", doctor_count=len(items))
    return {"items": items}
