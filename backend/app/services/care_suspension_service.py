"""Apply authenticated authority invalidations to work bound to original receipts.

All writes belong to the worker/caller transaction; no commits, new grants,
network calls, reassignment or automatic resumption happen here.
"""
from sqlalchemy import or_, select, update

from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.assessment import AssessmentSession
from backend.app.models.attention import AttentionItem
from backend.app.models.consent import ConsentRecord
from backend.app.models.identity import CareRelationship, GuardianRelationship
from backend.app.models.patient_task import PatientTask, PatientTaskStatus
from backend.app.models.submission import SubmissionRecord


def authority_invalidation(row, event_type):
    if isinstance(row, ConsentRecord):
        return row.purpose in {"basic_use", "clinical_sharing"} and event_type in {
            "consent.withdrawn", "consent.superseded", "consent.identity_invalidated"}
    if isinstance(row, CareRelationship):
        return event_type in {"care_relationship.revoked", "care_relationship.identity_invalidated"}
    if isinstance(row, GuardianRelationship):
        return event_type in {"guardian.suspend", "guardian.transfer", "guardian.adult_conversion"}
    return False


def suspend_assessment(db, session, reason):
    """Suspend unfinished work, preserving all completed original evidence/history."""
    from backend.app.services.attention_service import set_attention_state
    if session.status in {"draft", "active", "evidence_ready", "under_review", "suspended"}:
        if session.status != "suspended":
            session.status = "suspended"
            session.suspension_reason = reason
            session.version += 1
        for task in db.scalars(select(PatientTask).where(PatientTask.assessment_id == session.id,
                PatientTask.status == PatientTaskStatus.PENDING).with_for_update()).all():
            task.status = PatientTaskStatus.SUSPENDED
            task.suspension_reason = reason
    # Closing an assessment preserves its completed history, but does not
    # close a separate unresolved quality/responsibility item.
    for item in db.scalars(select(AttentionItem).where(AttentionItem.assessment_id == session.id,
            AttentionItem.status.in_(["open", "acknowledged", "in_progress"])).with_for_update()).all():
        set_attention_state(item, "suspended", reason)


def _authority_ref(db, event):
    payload = event.payload
    ref = payload.get("authority_ref") if isinstance(payload, dict) else None
    expected = {"table":event.aggregate_type,"id":event.aggregate_id,"revision":event.revision,
        "patient_id":event.patient_id,"event_type":event.event_type,
        "actor_user_id":event.actor_user_id,"actor_identity_basis":event.actor_identity_basis}
    if not isinstance(ref, dict) or any(ref.get(key) != value for key, value in expected.items()):
        raise RecordIntegrityError("Authority invalidation routing differs from its authenticated source.")
    models = {model.__tablename__:model for model in (ConsentRecord, CareRelationship, GuardianRelationship)}
    model = models.get(ref["table"])
    row = db.get(model, ref["id"]) if model else None
    if (row is None or row.patient_id != ref["patient_id"] or row.ledger_key != ref.get("ledger_key")
            or type(ref["revision"]) is not int or ref["revision"] < 1 or row.revision < ref["revision"]
            or not authority_invalidation(row, event.event_type)):
        raise RecordIntegrityError("Authority invalidation has no matching actual authority.")
    return ref


def _matches(snapshot, ref):
    from backend.app.services.submission_service import _receipt_tuples
    try:
        receipts = _receipt_tuples(snapshot)
        return any(patient == ref["patient_id"] and table == ref["table"] and identifier == ref["id"]
            and key == ref["ledger_key"] and type(revision) is int and revision <= ref["revision"]
            for _, patient, _, _, versions in receipts for table, key, revision, identifier in versions)
    except (TypeError, ValueError) as exc:
        raise RecordIntegrityError("Assessment authority snapshot is malformed.") from exc


def consume_authority_invalidation(db, event, now):
    """Consume one real invalidation without borrowing subsequently granted access."""
    ref = _authority_ref(db, event)
    # This trusted handler records denial internally; invalidated receipts must
    # never authorize disclosure or prevent committing the denial bookkeeping.
    db.info["authorization_receipts"] = []
    db.info["credential_receipts"] = []
    db.info["requires_basic_use"] = False
    identifiers = db.scalars(select(AssessmentSession.id).where(
        AssessmentSession.patient_id == event.patient_id,
        or_(AssessmentSession.status.in_(["draft", "active", "evidence_ready", "under_review", "suspended"]),
            select(AttentionItem.id).where(AttentionItem.assessment_id == AssessmentSession.id,
                AttentionItem.status.in_(["open", "acknowledged", "in_progress"])).exists()))
        .order_by(AssessmentSession.id)).all()
    for identifier in identifiers:
        # SQLite uses the conditional write lock; MySQL also locks the read.
        db.execute(update(AssessmentSession).where(AssessmentSession.id == identifier)
            .values(version=AssessmentSession.version).execution_options(synchronize_session=False))
        session = db.scalar(select(AssessmentSession).where(AssessmentSession.id == identifier)
            .with_for_update().execution_options(populate_existing=True))
        bound = _matches(session.authorization_snapshot, ref)
        if not bound:
            from backend.app.services.submission_service import _verify_record
            for submission in db.scalars(select(SubmissionRecord).where(
                    SubmissionRecord.assessment_id == identifier)).all():
                _verify_record(db, submission)
                if _matches(submission.authorization_snapshot, ref):
                    bound = True
                    break
        if bound:
            suspend_assessment(db, session, "original_authority_invalid")
    from backend.app.models.care_plan import CarePlan
    from backend.app.services.care_plan_service import suspend_plan
    for plan in db.scalars(select(CarePlan).where(CarePlan.patient_id == event.patient_id, CarePlan.status == 'active')
            .order_by(CarePlan.id).with_for_update()).all():
        if _matches(plan.snapshot['authorization_snapshot'], ref):
            suspend_plan(db, plan, 'original_authority_invalid', at=now, source_event_id=event.event_id)
