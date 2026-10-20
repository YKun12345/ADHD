"""Bounded persistent suspension and response-window facts for accepted successor work."""
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import event, select, update

from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.care_system_event import CareSystemEvent
from backend.app.models.care_transfer import CareTransferMaintenanceCursor, CareTransferWorkItem
from backend.app.services.care_authority_reconciliation import _context, _unavailable, verify_system_event
from backend.app.services.care_transfer_access import utc, verify_work, work_state
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.identity_access import recheck_request_authority
from backend.app.services import authorization_ledger
from backend.app.services.submission_service import _receipt_tuples

ACTIVE = ("open", "acknowledged")
PRINCIPAL = "care_transfer_maintenance"


def _key(row, kind):
    original = row.authorization_snapshot if kind == "authority_suspended" else utc(row.expected_response_at).isoformat()
    return f"transfer_work:{row.id}:{kind}:{canonical_digest(original)}"


def _verify(fact, row, kind):
    value = verify_system_event(fact)
    if (fact.patient_id, fact.assessment_id, fact.system_principal, fact.event_type, value.get("work_item_id"),
            value.get("decision_id"), value.get("accepted_authority_digest")) != (row.patient_id, row.assessment_id,
            PRINCIPAL, "transfer_work_" + kind, row.id, row.decision_id, canonical_digest(row.authorization_snapshot)):
        raise RecordIntegrityError("Successor work observation differs from the actual accepted scope.")
    if kind == "response_overdue" and (value.get("original_deadline"), value.get("original_coverage_digest")) != (
            utc(row.expected_response_at).isoformat(), canonical_digest(row.detail["response_coverage"])):
        raise RecordIntegrityError("Successor deadline observation changed its actual original window.")
    return value


def observations(db, row):
    result = {}
    for kind in ("authority_suspended", "response_overdue"):
        if kind == "response_overdue" and row.expected_response_at is None:
            continue
        fact = db.scalar(select(CareSystemEvent).where(CareSystemEvent.dedupe_key == _key(row, kind)))
        if not fact:
            continue
        value = _verify(fact, row, kind)
        common = {"system_principal": PRINCIPAL, "human_action": False, "observed_at": utc(fact.observed_at).isoformat()}
        if kind == "authority_suspended":
            result["suspension_observation"] = {**common, "reason_code": value["observation"]["code"]}
        else:
            result["overdue_observation"] = {**common, "original_deadline": value["original_deadline"],
                "status": "requires_institutional_action" if row.status in ACTIVE else "historical",
                "institutional_instructions": value["institutional_instructions"], "external_delivery_status": "not_configured"}
    return result


def _process(db, factory, identifier, observed):
    db.execute(update(CareTransferWorkItem).where(CareTransferWorkItem.id == identifier)
        .values(version=CareTransferWorkItem.version).execution_options(synchronize_session=False))
    row = db.get(CareTransferWorkItem, identifier, populate_existing=True, with_for_update=True)
    detail = verify_work(db, row)
    if row.status not in ACTIVE:
        return 0
    receipts = _receipt_tuples(row.authorization_snapshot)
    if not receipts or any(receipt[1] != row.patient_id for receipt in receipts):
        raise RecordIntegrityError("Successor work has no actual accepted authority for its subject.")
    failure = _unavailable(factory, receipts)
    kind = "authority_suspended" if failure else "response_overdue"
    if not failure and (row.expected_response_at is None or utc(row.expected_response_at) > observed):
        return 0
    if not failure:
        db.info["authorization_receipts"] = list(dict.fromkeys(db.info.get("authorization_receipts", []) + receipts))
    existing = db.scalar(select(CareSystemEvent).where(CareSystemEvent.dedupe_key == _key(row, kind)))
    if existing:
        _verify(existing, row, kind)
        return 0
    if failure:
        row.status, row.suspension_reason = "suspended", "original_authority_invalid"
        row.version += 1
        row.state_snapshot = work_state(row)
    coverage = detail["response_coverage"]
    if not failure and (coverage.get("status") != "configured" or not coverage.get("coverage")):
        raise RecordIntegrityError("Successor deadline has no actual accepted coverage.")
    fact = CareSystemEvent(event_id=uuid4().hex, patient_id=row.patient_id, assessment_id=row.assessment_id,
        system_principal=PRINCIPAL, event_type="transfer_work_" + kind, revision=row.version,
        observed_at=observed, dedupe_key=_key(row, kind))
    fact.payload = {"context_snapshot": _context(fact), "work_item_id": row.id, "decision_id": row.decision_id,
        "accepted_authority_digest": canonical_digest(row.authorization_snapshot), "human_action": False,
        "observation": failure, "original_deadline": utc(row.expected_response_at).isoformat() if row.expected_response_at else None,
        "original_coverage": coverage, "original_coverage_digest": canonical_digest(coverage),
        "institutional_instructions": coverage["coverage"]["escalation_instructions"] if not failure else None,
        "external_delivery_status": "not_configured"}
    db.add(fact)
    from backend.app.services.security_service import _append_audit_log
    _append_audit_log(db, action="care_transfer_work_" + kind, status="suspended" if failure else "requires_institutional_action",
        actor_user_id=None, patient_id=row.patient_id, message="继任事项的实际权限或原期望窗口后台观察。",
        detail_json={"work_item_id": row.id, "system_event_id": fact.event_id, "system_principal": PRINCIPAL})
    db.flush()
    return 1


@authorization_ledger.read_heads()
def maintain_once(session_factory, *, limit=50, clock=None, can_continue=lambda: True):
    if type(limit) is not int or not 1 <= limit <= 64:
        raise ValueError("Successor-work maintenance limit must be between 1 and 64.")
    observed = utc(clock() if clock else datetime.now(timezone.utc))
    changed = 0
    with session_factory() as db:
        def recheck(*_):
            if db.info.get("authorization_receipts"):
                recheck_request_authority(db)
        event.listen(db, "before_flush", recheck)
        event.listen(db, "before_commit", recheck)
        with db.begin():
            cursor = db.get(CareTransferMaintenanceCursor, PRINCIPAL, with_for_update=True)
            if cursor is None:
                cursor = CareTransferMaintenanceCursor(name=PRINCIPAL, last_work_id=0)
                db.add(cursor)
                db.flush()
            db.execute(update(CareTransferMaintenanceCursor).where(CareTransferMaintenanceCursor.name == PRINCIPAL)
                .values(last_work_id=CareTransferMaintenanceCursor.last_work_id))
            def identifiers():
                return db.scalars(select(CareTransferWorkItem.id).where(CareTransferWorkItem.id > cursor.last_work_id,
                    CareTransferWorkItem.status.in_(ACTIVE)).order_by(CareTransferWorkItem.id).limit(limit)).all()
            ids = identifiers()
            if not ids and cursor.last_work_id:
                cursor.last_work_id = 0
                ids = identifiers()
            for identifier in ids:
                if not can_continue():
                    break
                try:
                    with db.begin_nested():
                        amount = _process(db, session_factory, identifier, observed)
                    changed += amount
                except RecordIntegrityError:
                    from backend.app.services.security_service import _append_audit_log
                    _append_audit_log(db, action="care_transfer_maintenance_failed", status="failed", actor_user_id=None,
                        message="继任事项原件认证失败，原件保持。", detail_json={"work_item_id": identifier,
                            "system_principal": PRINCIPAL, "failure_type": "RecordIntegrityError"})
                cursor.last_work_id = identifier
    return changed
