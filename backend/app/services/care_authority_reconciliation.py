"""Bounded internal suspension of work whose original authority has failed.

Request-time access remains authoritative and immediate. This scanner grants no
access, sends nothing, and records a real system observation rather than a user
action or a guessed historical invalidation time.
"""
from datetime import datetime, timezone
import json
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import or_, select, update

from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.assessment import AssessmentSession
from backend.app.models.attention import AttentionItem
from backend.app.models.care_system_event import CareReconciliationCursor, CareSystemEvent
from backend.app.models.submission import SubmissionRecord
from backend.app.models.care_plan import CarePlan
from backend.app.services.attention_service import verify_attention
from backend.app.services.care_suspension_service import suspend_assessment
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.identity_access import recheck_receipts
from backend.app.services import authorization_ledger
from backend.app.services.submission_service import _receipt_tuples, _verify_record

PRINCIPAL = "care_authority_reconciler"
ACTIVE = ("draft", "active", "evidence_ready", "under_review")
OPEN_ATTENTION = ("open", "acknowledged", "in_progress")


def _utc(value):
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def _context(row):
    return {"event_id": row.event_id, "patient_id": row.patient_id, "assessment_id": row.assessment_id,
        "system_principal": row.system_principal, "event_type": row.event_type, "revision": row.revision,
        "observed_at": _utc(row.observed_at).isoformat(), "dedupe_key": row.dedupe_key}


def verify_system_event(row):
    value = row.payload
    if not isinstance(value, dict) or value.get("context_snapshot") != _context(row):
        raise RecordIntegrityError("System event routing differs from its authenticated observation.")
    return value


def _originals(db, assessment):
    originals = []
    sources = [assessment.authorization_snapshot]
    sources.extend(row.snapshot['authorization_snapshot'] for row in db.scalars(select(CarePlan).where(
        CarePlan.assessment_id == assessment.id, CarePlan.status == 'active')).all())
    for row in db.scalars(select(SubmissionRecord).where(SubmissionRecord.assessment_id == assessment.id)).all():
        _verify_record(db, row)
        sources.append(row.authorization_snapshot)
    for row in db.scalars(select(AttentionItem).where(AttentionItem.assessment_id == assessment.id)).all():
        verify_attention(row)
        # Verify the authenticated original source as well as its stored receipt.
        from backend.app.services.attention_action_service import _source
        _source(db, row)
        sources.append(row.detail["authorization_snapshot"])
    for snapshot in sources:
        try:
            receipts = _receipt_tuples(snapshot)
            if not receipts or any(receipt[1] != assessment.patient_id for receipt in receipts):
                raise ValueError("missing or different subject")
        except (TypeError, ValueError, IndexError) as exc:
            raise RecordIntegrityError("Original assessment authority is incomplete or belongs to another subject.") from exc
        for receipt in receipts:
            if receipt not in originals:
                originals.append(receipt)
    return originals


def _unavailable(session_factory, originals):
    with session_factory() as checker:
        try:
            recheck_receipts(checker, originals)
        except HTTPException as exc:
            if exc.status_code not in {403, 409}:
                raise
            # The actual observation is access failure, not a guessed cause/date.
            return {"code": _observed_cause(checker, originals), "observed_denial_status": exc.status_code,
                "original_authority_digest": canonical_digest(json.loads(json.dumps(originals)))}
    return None


def _observed_cause(db, originals):
    from backend.app.models.identity import (PatientAccess, GuardianRelationship, DoctorQualification,
        InstitutionMembership, CareRelationship)
    from backend.app.models.consent import ConsentRecord
    from backend.app.models.user import User
    models = {model.__tablename__: model for model in (PatientAccess, GuardianRelationship,
        DoctorQualification, InstitutionMembership, CareRelationship, ConsentRecord)}
    for actor, _, _, _, _ in originals:
        user = db.get(User, actor, populate_existing=True)
        if user is None or not user.is_active:
            return "account_disabled" if user is not None else "original_account_unavailable"
    for _, _, _, _, versions in originals:
        for table, key, revision, identifier in versions:
            model = models.get(table)
            row = db.get(model, identifier, populate_existing=True) if model else None
            if row is not None and row.expires_at is not None and _utc(row.expires_at) <= datetime.now(timezone.utc):
                return {"doctor_qualifications": "doctor_qualification_expired", "institution_memberships": "institution_membership_expired",
                    "guardian_relationships": "guardian_relationship_expired", "patient_access": "patient_identity_expired",
                    "care_relationships": "clinical_relationship_expired", "consent_records": "purpose_consent_expired"}.get(table, "original_authority_invalid")
    return "original_authority_invalid"


def _reconcile_assessment(db, session_factory, identifier, observed):
    db.execute(update(AssessmentSession).where(AssessmentSession.id == identifier)
        .values(version=AssessmentSession.version).execution_options(synchronize_session=False))
    assessment = db.scalar(select(AssessmentSession).where(AssessmentSession.id == identifier)
        .with_for_update().execution_options(populate_existing=True))
    originals = _originals(db, assessment)
    failure = _unavailable(session_factory, originals)
    plans = db.scalars(select(CarePlan).where(CarePlan.assessment_id == identifier, CarePlan.status == 'active').with_for_update()).all()
    if failure is None and plans:
        from backend.app.services.care_plan_service import _original_credentials
        with session_factory() as checker:
            for plan in plans:
                try:
                    _original_credentials(checker, plan.snapshot['credential_snapshot'])
                except HTTPException as exc:
                    if exc.status_code not in {403, 409}:
                        raise
                    failure = {'code': 'original_plan_credential_invalid', 'observed_denial_status': exc.status_code,
                        'original_authority_digest': canonical_digest({'originals': originals, 'plan_credentials': plan.snapshot['credential_snapshot']})}
                    break
    if failure is None:
        return 0
    key = f"authority_reconciliation:{identifier}:{failure['original_authority_digest']}"
    existing = db.scalar(select(CareSystemEvent).where(CareSystemEvent.dedupe_key == key))
    if existing:
        verify_system_event(existing)
        return 0
    # This denial bookkeeping does not publish under failed grants.
    db.info["authorization_receipts"] = []
    db.info["credential_receipts"] = []
    db.info["requires_basic_use"] = False
    previous = assessment.version
    suspend_assessment(db, assessment, "original_authority_invalid")
    from backend.app.services.care_plan_service import suspend_plan
    for plan in plans:
        suspend_plan(db, plan, 'original_authority_invalid', at=observed)
    fact = CareSystemEvent(event_id=uuid4().hex, patient_id=assessment.patient_id, assessment_id=identifier,
        system_principal=PRINCIPAL, event_type="original_authority_suspended", revision=assessment.version,
        observed_at=observed, dedupe_key=key)
    fact.payload = {"context_snapshot": _context(fact), "previous_assessment_version": previous,
        "original_authorization_snapshot": originals, "observation": failure,
        "human_action": False, "external_notification_sent": False}
    db.add(fact)
    from backend.app.services.security_service import _append_audit_log
    _append_audit_log(db, action="care_authority_reconciled", status="suspended", actor_user_id=None,
        patient_id=assessment.patient_id, message="后台发现原权限不可用，已持久暂停未完成工作。",
        detail_json={"system_principal": PRINCIPAL, "assessment_id": identifier,
            "system_event_id": fact.event_id, "observed_at": observed.isoformat(),
            "original_authority_digest": failure["original_authority_digest"]})
    db.flush()
    return 1


@authorization_ledger.read_heads()
def reconcile_once(session_factory, *, limit=50, clock=None, can_continue=lambda: True):
    if type(limit) is not int or not 1 <= limit <= 64:
        raise ValueError("Reconciliation batch size must be between 1 and 64.")
    observed = _utc(clock() if clock else datetime.now(timezone.utc))
    changed = 0
    with session_factory() as db:
        with db.begin():
            # Durable cursor advances past lawful work too, avoiding starvation.
            cursor = db.get(CareReconciliationCursor, PRINCIPAL, with_for_update=True)
            if cursor is None:
                cursor = CareReconciliationCursor(name=PRINCIPAL, last_assessment_id=0)
                db.add(cursor)
                db.flush()
            db.execute(update(CareReconciliationCursor).where(CareReconciliationCursor.name == PRINCIPAL)
                .values(last_assessment_id=CareReconciliationCursor.last_assessment_id))
            work = or_(AssessmentSession.status.in_(ACTIVE), select(CarePlan.id).where(
                CarePlan.assessment_id == AssessmentSession.id, CarePlan.status == 'active').exists(), select(AttentionItem.id).where(
                AttentionItem.assessment_id == AssessmentSession.id, AttentionItem.status.in_(OPEN_ATTENTION)).exists())
            identifiers = db.scalars(select(AssessmentSession.id).where(work, AssessmentSession.id > cursor.last_assessment_id)
                .order_by(AssessmentSession.id).limit(limit)).all()
            if not identifiers:
                cursor.last_assessment_id = 0
            for identifier in identifiers:
                if not can_continue():
                    break
                try:
                    with db.begin_nested():
                        amount = _reconcile_assessment(db, session_factory, identifier, observed)
                    changed += amount
                except RecordIntegrityError:
                    # Leave the corrupt original untouched. Record a critical
                    # internal failure and retry it after the cursor wraps.
                    from backend.app.services.security_service import _append_audit_log
                    _append_audit_log(db, action="care_reconciliation_failed", status="failed", actor_user_id=None,
                        message="原件完整性核验失败，未暂停该项工作。",
                        detail_json={"system_principal": PRINCIPAL, "assessment_id": identifier,
                            "observed_at": observed.isoformat(), "failure_type": "RecordIntegrityError"})
                cursor.last_assessment_id = identifier
    return changed
