"""Fixed transactional consumers for actual assessment evidence and responsibility."""
from fastapi import HTTPException
from sqlalchemy import select, update

from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.assessment import AssessmentSession
from backend.app.models.attention import AttentionItem
from backend.app.models.patient_task import PatientTask, PatientTaskStatus
from backend.app.models.submission import SubmissionRecord
from backend.app.services.assessment_service import _bound_relationship
from backend.app.services.event_service import append_care_event
from backend.app.services.identity_access import recheck_receipts
from backend.app.services.submission_service import _receipt_tuples, _verify_record, valid_evidence_manifest


def _context(db,event,event_type):
    payload = event.payload
    if event.event_type != event_type or not isinstance(payload,dict):
        raise RecordIntegrityError("Unexpected event type or authenticated payload.")
    assessment_id = payload.get("assessment_id")
    # SQLite ignores FOR UPDATE; take the same write lock used by submitters
    # before reading state, while MySQL also uses the locking read below.
    db.execute(update(AssessmentSession).where(AssessmentSession.id == assessment_id).values(version=AssessmentSession.version))
    session = db.scalar(select(AssessmentSession).where(AssessmentSession.id == assessment_id)
        .with_for_update().execution_options(populate_existing=True))
    if session is None or session.patient_id != event.patient_id:
        raise RecordIntegrityError("Event does not belong to its actual assessment.")
    return session,payload


def _original_submission(db,event,payload):
    row = db.scalar(select(SubmissionRecord).where(SubmissionRecord.id == event.aggregate_id))
    if event.aggregate_type != "submission" or row is None or (
        row.patient_id,row.assessment_id,row.submission_id,row.attempt_id) != (
        event.patient_id,payload.get("assessment_id"),payload.get("submission_id"),payload.get("attempt_id")):
        raise RecordIntegrityError("Event and actual immutable submission association differ.")
    _verify_record(db,row)
    if payload.get("authorization_snapshot") != row.authorization_snapshot or payload.get("quality_status") != row.quality_status:
        raise RecordIntegrityError("Event authority or quality differs from actual immutable evidence.")
    return row


def _pause(db,session):
    from backend.app.services.care_suspension_service import suspend_assessment
    suspend_assessment(db,session,"original_authority_invalid")
    # This branch records suspension internally. It neither discloses evidence
    # nor publishes a new shared product under the authority that just failed.
    db.info["authorization_receipts"] = []
    db.info["credential_receipts"] = []
    db.info["requires_basic_use"] = False
    return "suspended"


def _processing(db,session,payload):
    originals = []
    for snapshot in (session.authorization_snapshot,payload.get("authorization_snapshot")):
        if not snapshot:
            raise RecordIntegrityError("A processing event requires its original authority snapshot.")
        originals.extend(receipt for receipt in _receipt_tuples(snapshot) if receipt not in originals)
    try:
        recheck_receipts(db,originals)
    except HTTPException as exc:
        if exc.status_code not in {403,409}:
            raise
        return _pause(db,session)
    db.info["authorization_receipts"] = originals
    return "suspended" if session.status in {"suspended","cancelled"} else None


def _attention(db,event,session,kind,now,submission=None):
    from backend.app.services.attention_service import attention_context, state_values, verify_attention
    from backend.app.services.service_coverage_service import current_coverage, unknown_coverage, working_deadline
    existing = db.scalar(select(AttentionItem).where(AttentionItem.source_event_id == event.event_id,AttentionItem.kind == kind))
    if existing is not None:
        verify_attention(existing)
        return existing
    coverage = current_coverage(db,session.responsible_doctor_id,at=now) if session.responsible_doctor_id else unknown_coverage()
    deadline = working_deadline(now,coverage["coverage"]["working_periods"],
        coverage["coverage"]["expected_response_working_minutes"]) if coverage["status"] == "configured" else None
    values = {"source_event_id":event.event_id,"kind":kind,"patient_id":session.patient_id,
        "assessment_id":session.id,"submission_id":submission.submission_id if submission else None,
        "owner_kind":"doctor" if session.responsible_doctor_id else "patient_self",
        "responsible_doctor_id":session.responsible_doctor_id,
        "relationship_id":_bound_relationship(session) if session.responsible_doctor_id else None,
        "created_for_user_id":event.actor_user_id,"status":"open","version":1,
        "suspension_reason":None,"expected_response_at":deadline,"created_at":now}
    row = AttentionItem(**values,
        detail={"context_snapshot":{key:values[key] for key in attention_context()},
            "assessment_version":session.version,"authorization_snapshot":event.payload["authorization_snapshot"],
            "quality_reasons":list(submission.quality_reasons) if submission else [],
            "response_coverage":coverage},state_snapshot={})
    row.state_snapshot = state_values(row)
    db.add(row)
    return row


def consume_progress(db,event,now):
    session,payload = _context(db,event,"submission_committed")
    row = _original_submission(db,event,payload)
    if payload.get("canonical_digest") != row.canonical_digest:
        raise RecordIntegrityError("Submission event digest differs from its actual original.")
    if _processing(db,session,payload) == "suspended":
        return "suspended"
    if session.source == "doctor_assigned" and row.quality_status == "valid":
        task = db.scalar(select(PatientTask).where(PatientTask.id == row.task_id))
        if task is None or task.legacy or (task.assessment_id,task.assessment_item_id,task.researcher_id) != (
            session.id,row.assessment_item_id,session.responsible_doctor_id):
            raise RecordIntegrityError("Actual submitted evidence does not match its doctor's task.")
        if task.status == PatientTaskStatus.PENDING:
            task.status = PatientTaskStatus.COMPLETED
            task.completed_at = row.committed_at


def consume_ready(db,event,now):
    session,payload = _context(db,event,"assessment_evidence_ready")
    if event.aggregate_type != "assessment" or event.aggregate_id != session.id or (
        payload.get("source"),payload.get("responsible_doctor_id"),payload.get("assessment_version")) != (
        session.source,session.responsible_doctor_id,event.revision):
        raise RecordIntegrityError("Ready event context differs from the actual assessment.")
    if _processing(db,session,payload) == "suspended":
        return "suspended"
    if session.status != "evidence_ready" or session.version != event.revision:
        return
    manifest = valid_evidence_manifest(db,session)
    if manifest is None:
        raise RecordIntegrityError("Materials-ready has no complete applicable valid evidence.")
    session.status = "closed_self" if session.source == "self" else "under_review"
    session.version += 1
    if session.source == "self":
        from backend.app.services.self_report_service import publish_self_report
        report = publish_self_report(db, session, event, manifest, now)
        append_care_event(db,patient_id=session.patient_id,actor_user_id=event.actor_user_id,
            event_type="assessment_closed_self",aggregate_type="assessment",aggregate_id=session.id,revision=session.version,
            payload={"assessment_id":session.id,"assessment_version":session.version,"category":"self_screening",
                "evidence_manifest":manifest,"report_id":report.id,"authorization_snapshot":payload["authorization_snapshot"],
                "demonstration_only":session.demonstration_only},dedupe_key=f"self_closed:{session.id}")
    else:
        _attention(db,event,session,"evidence_review",now)


def consume_quality(db,event,now):
    session,payload = _context(db,event,"assessment_quality_issue")
    row = _original_submission(db,event,payload)
    if row.quality_status not in {"limited","invalid"} or payload.get("quality_reasons") != row.quality_reasons:
        raise RecordIntegrityError("Quality event does not match its actual original quality reasons.")
    if _processing(db,session,payload) == "suspended":
        return "suspended"
    later_valid = db.scalar(select(SubmissionRecord.id).where(SubmissionRecord.assessment_item_id == row.assessment_item_id,
        SubmissionRecord.id > row.id,SubmissionRecord.quality_status == "valid",SubmissionRecord.config_digest == row.config_digest))
    if later_valid is not None:
        later = db.get(SubmissionRecord,later_valid)
        _verify_record(db,later)
        return
    _attention(db,event,session,"assessment_quality",now,row)


def consumer_handlers():
    from backend.app.services.care_suspension_service import consume_authority_invalidation
    return {"assessment_progress":consume_progress,"assessment_evidence_ready":consume_ready,
        "assessment_quality_attention":consume_quality,"care_authority_invalidation":consume_authority_invalidation}
