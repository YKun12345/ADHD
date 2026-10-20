"""Persist original response-window observations without resolving the attention."""
from datetime import datetime, timezone
import json
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import event, select, update

from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.attention import AttentionItem
from backend.app.models.care_system_event import CareDeadlineCursor, CareSystemEvent
from backend.app.services.attention_service import verify_attention
from backend.app.services.care_authority_reconciliation import _context, verify_system_event
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.identity_access import recheck_receipts, recheck_request_authority
from backend.app.services import authorization_ledger
from backend.app.services.submission_service import _receipt_tuples

PRINCIPAL = "attention_deadline_monitor"
OPEN = ("open", "acknowledged", "in_progress")


def _utc(value):
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def _key(row):
    return f"attention_deadline:{row.id}:{canonical_digest(_utc(row.expected_response_at).isoformat())}"


def _verify_event(fact, row):
    value = verify_system_event(fact)
    if (fact.patient_id, fact.assessment_id, fact.system_principal, fact.event_type,
            value.get("attention_id"), value.get("original_deadline"), value.get("original_coverage_digest"),
            value.get("source_event_id")) != (row.patient_id, row.assessment_id, PRINCIPAL, "attention_response_overdue",
            row.id, _utc(row.expected_response_at).isoformat(), canonical_digest(row.detail["response_coverage"]), row.source_event_id):
        raise RecordIntegrityError("Deadline observation does not match its actual original attention and coverage.")
    return value


def overdue_observation(db, row):
    if row.expected_response_at is None:
        return None
    fact = db.scalar(select(CareSystemEvent).where(CareSystemEvent.dedupe_key == _key(row)))
    if fact is None:
        return None
    value = _verify_event(fact, row)
    return {"system_principal": PRINCIPAL, "observed_at": _utc(fact.observed_at).isoformat(),
        "original_deadline": value["original_deadline"], "status": "requires_institutional_action" if row.status in OPEN else "historical",
        "institutional_instructions": value["institutional_instructions"], "external_delivery_status": "not_configured",
        "human_action": False}


def _monitor_attention(db, session_factory, identifier, observed):
    db.execute(update(AttentionItem).where(AttentionItem.id == identifier)
        .values(version=AttentionItem.version).execution_options(synchronize_session=False))
    row = db.scalar(select(AttentionItem).where(AttentionItem.id == identifier).with_for_update()
        .execution_options(populate_existing=True))
    verify_attention(row)
    if row.status not in OPEN or row.owner_kind != "doctor" or row.expected_response_at is None or _utc(row.expected_response_at) > observed:
        return 0
    from backend.app.services.attention_action_service import _source
    assessment, snapshot = _source(db, row)
    if assessment.status in {"suspended", "cancelled"}:
        return 0
    coverage = row.detail["response_coverage"]
    if coverage.get("status") != "configured" or not isinstance(coverage.get("coverage"), dict):
        raise RecordIntegrityError("A response deadline requires its actual original institutional coverage.")
    receipts = _receipt_tuples(snapshot)
    with session_factory() as checker:
        try:
            recheck_receipts(checker, receipts)
        except HTTPException as exc:
            if exc.status_code not in {403, 409}:
                raise
            return 0  # The separate reconciliation records real suspension.
    prior = db.info.setdefault("authorization_receipts", [])
    for receipt in receipts:
        if receipt not in prior:
            prior.append(receipt)
    existing = db.scalar(select(CareSystemEvent).where(CareSystemEvent.dedupe_key == _key(row)))
    if existing:
        _verify_event(existing, row)
        return 0
    fact = CareSystemEvent(event_id=uuid4().hex, patient_id=row.patient_id, assessment_id=row.assessment_id,
        system_principal=PRINCIPAL, event_type="attention_response_overdue", revision=row.version,
        observed_at=observed, dedupe_key=_key(row))
    fact.payload = {"context_snapshot": _context(fact), "attention_id": row.id, "source_event_id": row.source_event_id,
        "status_when_observed": row.status, "original_deadline": _utc(row.expected_response_at).isoformat(),
        "original_coverage": coverage, "original_coverage_digest": canonical_digest(coverage),
        "institutional_instructions": coverage["coverage"]["escalation_instructions"],
        "original_authorization_snapshot": json.loads(json.dumps(receipts)), "human_action": False,
        "external_delivery_status": "not_configured"}
    db.add(fact)
    from backend.app.services.security_service import _append_audit_log
    _append_audit_log(db, action="attention_deadline_observed", status="requires_institutional_action", actor_user_id=None,
        patient_id=row.patient_id, message="原期望窗口已到，已保存独立站内升级记录；事项状态未改变。",
        detail_json={"system_principal": PRINCIPAL, "system_event_id": fact.event_id,
            "attention_id": row.id, "original_deadline": _utc(row.expected_response_at).isoformat()})
    db.flush()
    return 1


@authorization_ledger.read_heads()
def monitor_once(session_factory, *, limit=50, clock=None, can_continue=lambda: True):
    if type(limit) is not int or not 1 <= limit <= 64:
        raise ValueError("Deadline monitoring batch size must be between 1 and 64.")
    observed = _utc(clock() if clock else datetime.now(timezone.utc))
    changed = 0
    with session_factory() as db:
        def recheck(*_):
            if db.info.get("authorization_receipts"):
                recheck_request_authority(db)
        event.listen(db, "before_flush", recheck)
        event.listen(db, "before_commit", recheck)
        with db.begin():
            cursor = db.get(CareDeadlineCursor, PRINCIPAL, with_for_update=True)
            if cursor is None:
                cursor = CareDeadlineCursor(name=PRINCIPAL, last_attention_id=0)
                db.add(cursor)
                db.flush()
            db.execute(update(CareDeadlineCursor).where(CareDeadlineCursor.name == PRINCIPAL)
                .values(last_attention_id=CareDeadlineCursor.last_attention_id))
            identifiers = db.scalars(select(AttentionItem.id).where(AttentionItem.id > cursor.last_attention_id,
                AttentionItem.owner_kind == "doctor", AttentionItem.status.in_(OPEN),
                AttentionItem.expected_response_at <= observed).order_by(AttentionItem.id).limit(limit)).all()
            if not identifiers:
                cursor.last_attention_id = 0
            for identifier in identifiers:
                if not can_continue():
                    break
                try:
                    with db.begin_nested():
                        amount = _monitor_attention(db, session_factory, identifier, observed)
                    changed += amount
                except RecordIntegrityError:
                    from backend.app.services.security_service import _append_audit_log
                    _append_audit_log(db, action="attention_deadline_monitor_failed", status="failed", actor_user_id=None,
                        message="超时原件完整性核验失败，未形成升级记录。", detail_json={"system_principal": PRINCIPAL,
                            "attention_id": identifier, "failure_type": "RecordIntegrityError"})
                cursor.last_attention_id = identifier
    return changed
