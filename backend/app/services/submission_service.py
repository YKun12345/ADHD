"""One authoritative transaction for real results, state, outbox and audit."""
from datetime import datetime,timezone
import json

from fastapi import HTTPException
from sqlalchemy import func,or_,select,update
from sqlalchemy.exc import IntegrityError

from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.assessment import AssessmentSession,AssessmentItem,TaskAttempt
from backend.app.models.submission import SubmissionRecord
from backend.app.models.patient_task import PatientTask
from backend.app.models.scale_result import ScaleResult
from backend.app.models.cognitive_test import CognitiveTest
from backend.app.schemas.submission import SubmissionAck
from backend.app.services.assessment_service import _own_processing,_guard_active_context,_require_visible,authorization_snapshot
from backend.app.services.identity_access import require_patient_access,recheck_receipts
from backend.app.services.cognitive_contract import canonical_digest,canonical_test_type
from backend.app.services.event_service import append_care_event,append_submission_audit,mark_transaction_audit_committed
from backend.app.services.security_service import capture_scale_result_cipher,capture_cognitive_test_cipher

CONTEXT = ("submission_id","kind","patient_id","assessment_id","assessment_item_id","attempt_id","run_id","task_id","protocol_id","protocol_schema_version","config_digest","template_digest","actor_user_id","performer_kind","performer_user_id","performer_patient_id","respondent_user_id","respondent_kind","submitter_user_id")
RULE_VERSION = "w04-engineering-quality-v1"
AUTHENTICATED_STATUS_FIELDS = ("execution_status", "quality_status", "quality_reasons", "quality_rule_version",
    "comparability_status", "comparability_reasons", "acceptance_status", "authorization_snapshot")


def context_dict(row):
    return {key:getattr(row,key) for key in CONTEXT}


def _receipt_tuples(snapshot):
    return [(actor,patient,tuple(scope),purpose,tuple(tuple(version) for version in versions)) for actor,patient,scope,purpose,versions in snapshot]


def _recheck_original_attempt(db,attempt):
    previous = list(db.info.get("authorization_receipts",[]))
    originals = _receipt_tuples(attempt.authorization_snapshot)
    recheck_receipts(db,originals)
    db.info["authorization_receipts"] = previous + [receipt for receipt in originals if receipt not in previous]
    request = db.info.get("authorization_request")
    if request is not None:
        request.state.authorization_receipts = db.info["authorization_receipts"]


def _assert_context(payload,attempt,item,session,task_id):
    expected = {"patient_id":attempt.patient_id,"assessment_id":attempt.assessment_id,"assessment_item_id":attempt.assessment_item_id,"attempt_id":attempt.id,"run_id":attempt.run_id,"kind":item.kind,"task_id":task_id,**{key:getattr(attempt,key) for key in ("protocol_id","protocol_schema_version","config_digest","template_digest","actor_user_id","performer_kind","performer_user_id","performer_patient_id","respondent_user_id","respondent_kind","submitter_user_id")}}
    if any(getattr(payload,key) != value for key,value in expected.items()):
        raise HTTPException(409,"The submission conflicts with its immutable server attempt context.")
    if session.source == "self" and task_id is not None or session.source == "doctor_assigned" and task_id is None:
        raise HTTPException(409,"Actual self/doctor task linkage does not match this assessment.")


def _canonical_content(payload):
    content = payload.content.model_dump()
    if payload.kind == "cognitive":
        try:
            content["test_type"] = canonical_test_type(content["test_type"])
        except ValueError as exc:
            raise HTTPException(422,str(exc)) from exc
    try:
        encoded = json.dumps(content,ensure_ascii=False,allow_nan=False)
        canonical_digest(content)
    except (ValueError,TypeError) as exc:
        raise HTTPException(422,"Content must contain finite JSON values.") from exc
    if len(encoded.encode("utf-8")) > 2*1024*1024:
        raise HTTPException(422,"Submission content exceeds its bounded evidence size.")
    return content


def _verify_record(db,row):
    stored = row.content
    metadata = row.execution_metadata
    if metadata.get("context_snapshot") != context_dict(row) or canonical_digest({"context":context_dict(row),"content":stored}) != row.canonical_digest:
        raise RecordIntegrityError("Immutable submission context or digest differs from authenticated evidence.")
    if metadata.get("submission_snapshot") != {key:getattr(row,key) for key in AUTHENTICATED_STATUS_FIELDS}:
        raise RecordIntegrityError("Submission state or authorization differs from its authenticated immutable snapshot.")
    result = db.get(ScaleResult,row.scale_result_id) if row.kind == "scale" else db.get(CognitiveTest,row.cognitive_result_id)
    if metadata.get("result_ref") != {"kind":row.kind,"id":row.scale_result_id if row.kind == "scale" else row.cognitive_result_id}:
        raise RecordIntegrityError("The actual result reference differs from the authenticated association.")
    if not result or result.legacy or (result.patient_id,result.assessment_id,result.assessment_item_id,result.task_attempt_id) != (row.patient_id,row.assessment_id,row.assessment_item_id,row.attempt_id):
        raise RecordIntegrityError("The submission's actual result association is inconsistent.")
    if row.kind == "scale":
        result.score_json,result.total_score,result.risk_level
    else:
        result.result_json


def ack_response(db,row):
    _verify_record(db,row)
    session = db.get(AssessmentSession,row.assessment_id,populate_existing=True)
    item = db.get(AssessmentItem,row.assessment_item_id,populate_existing=True)
    return SubmissionAck(**{key:getattr(row,key) for key in ("submission_id","patient_id","assessment_id","assessment_item_id","attempt_id","run_id","task_id","canonical_digest","execution_status","quality_status","quality_reasons","quality_rule_version","comparability_status","comparability_reasons","acceptance_status","committed_at")},result={"kind":row.kind,"id":row.scale_result_id if row.kind == "scale" else row.cognitive_result_id,"legacy":False},assessment_status=session.status,assessment_version=session.version,item_version=item.version)


def _result(db,patient,item,attempt,session,content):
    common = {"patient_id":patient.id,"assessment_id":session.id,"assessment_item_id":item.id,"task_attempt_id":attempt.id,"legacy":False}
    if item.kind == "scale":
        from backend.app.api.routes.patient import _asrs_scores,_snap_scores,_build_summary,_build_recommendations
        answers = content["answers"]
        count,maximum = (18,4) if item.instrument == "ASRS" else (26,3)
        if content["scale_type"] != item.instrument or len(answers) != count or any(type(answer) is not int or not 0 <= answer <= maximum for answer in answers) or content["recall_window"] != attempt.recall_window or content["content_digest"] != item.definition_snapshot["content_digest"]:
            raise HTTPException(422,"Actual complete scale answers, frozen wording and P6M window are required.")
        subs,radar,risk = (_asrs_scores if item.instrument == "ASRS" else _snap_scores)(answers)
        record = ScaleResult(**common,scale_type=item.instrument,score_json={"answers":answers,"respondent_type":attempt.respondent_kind,"sub_scores":subs,"radar_scores":radar,"summary":_build_summary(item.instrument,risk),"recommendations":_build_recommendations(item.instrument,risk),"quality_rule_version":RULE_VERSION,"demonstration_only":session.demonstration_only},total_score=float(sum(answers)),risk_level=risk)
        quality,reasons,comparison = "valid",[],["P6M_window_overlap_requires_professional_interpretation","professional_template_admission_not_approved"]
        completion = {}
    else:
        from backend.app.services.cognitive_validation import validate_cognitive_evidence
        computed,quality,reasons,comparison = validate_cognitive_evidence(content,attempt,item.definition_snapshot)
        record = CognitiveTest(**common,test_type=item.instrument,test_run_id=attempt.run_id,result_json=computed)
        completion = content["execution_metadata"]
    db.add(record)
    db.flush()
    (capture_scale_result_cipher if item.kind == "scale" else capture_cognitive_test_cipher)(db,patient,record)
    return record,quality,reasons,comparison,completion


def valid_evidence_manifest(db,session,items=None):
    """All applicable valid originals; readiness never chooses a highest score."""
    if items is None:
        items = db.scalars(select(AssessmentItem).where(AssessmentItem.assessment_id == session.id).execution_options(populate_existing=True)).all()
    definitions = {candidate.id: candidate.definition_snapshot for candidate in items}
    from backend.app.services.review_followup_service import repeat_state
    _, repeat_barriers = repeat_state(db, session)
    manifest = []
    for submission in db.scalars(select(SubmissionRecord).where(
        SubmissionRecord.assessment_id == session.id,
        SubmissionRecord.patient_id == session.patient_id,
        SubmissionRecord.execution_status == "submitted",
        SubmissionRecord.quality_status == "valid",
    ).order_by(SubmissionRecord.id)).all():
        definition = definitions.get(submission.assessment_item_id)
        if submission.attempt_id <= repeat_barriers.get(submission.assessment_item_id, 0):
            continue
        if definition is None or (submission.kind, submission.protocol_id, submission.protocol_schema_version, submission.config_digest, submission.template_digest) != (
            definition["kind"], definition["protocol_id"], definition["protocol_schema_version"], definition["config_digest"], session.template_digest
        ):
            continue
        _verify_record(db, submission)
        manifest.append({"assessment_item_id":submission.assessment_item_id,"submission_id":submission.submission_id,
            "canonical_digest":submission.canonical_digest,"kind":submission.kind,
            "result_id":submission.scale_result_id if submission.kind == "scale" else submission.cognitive_result_id,
            "protocol_id":submission.protocol_id,"protocol_schema_version":submission.protocol_schema_version,
            "config_digest":submission.config_digest,"template_digest":submission.template_digest,
            "quality_rule_version":submission.quality_rule_version})
    # Item status describes the latest attempt. Readiness describes whether each
    # applicable item has actual valid evidence, including preserved earlier runs.
    valid_items = {row["assessment_item_id"] for row in manifest}
    return manifest if items and all(candidate.id in valid_items for candidate in items) else None


def _advance(db,attempt,item,session,quality):
    changed = db.execute(update(TaskAttempt).where(TaskAttempt.id == attempt.id,TaskAttempt.execution_status == "in_progress").values(execution_status="submitted",quality_status=quality))
    if changed.rowcount != 1:
        raise HTTPException(409,"This attempt is already submitted or cancelled.")
    latest = db.scalar(select(func.max(TaskAttempt.id)).where(TaskAttempt.assessment_item_id == item.id))
    if latest == attempt.id:
        db.execute(update(AssessmentItem).where(AssessmentItem.id == item.id).values(execution_status="submitted",quality_status=quality,version=AssessmentItem.version+1))
    db.flush()
    ready = valid_evidence_manifest(db,session) is not None
    old_version = session.version
    changed = db.execute(update(AssessmentSession).where(AssessmentSession.id == session.id,AssessmentSession.status == session.status,AssessmentSession.version == old_version).values(version=old_version+1,status="evidence_ready" if ready else session.status))
    if changed.rowcount != 1:
        raise HTTPException(409,"A concurrent assessment change requires an unchanged retry after refresh.")
    return ready,old_version+1


def submit(db,user,payload):
    patient = _own_processing(db,user,payload.patient_id)
    existing = db.scalar(select(SubmissionRecord).where(SubmissionRecord.submission_id == payload.submission_id))
    if existing is not None and context_dict(existing) != context_dict(payload):
        raise HTTPException(409,"This submission ID already belongs to a different immutable context.")
    attempt = db.get(TaskAttempt,payload.attempt_id)
    if attempt is None:
        raise HTTPException(404,"Attempt not found.")
    if attempt.patient_id != patient.id or attempt.actor_user_id != user.id or attempt.submitter_user_id != user.id:
        raise HTTPException(403,"Only the original actual user or verified guardian can submit this attempt.")
    item = db.get(AssessmentItem,attempt.assessment_item_id)
    # Lock the aggregate before loading its current state/version. SQLite's
    # write transaction serializes contenders; MySQL also holds this row lock.
    db.execute(update(AssessmentSession).where(AssessmentSession.id == attempt.assessment_id).values(version=AssessmentSession.version))
    session = db.get(AssessmentSession,attempt.assessment_id,populate_existing=True)
    _require_visible(session,user)
    task_id = db.scalar(select(PatientTask.id).where(PatientTask.assessment_item_id == item.id))
    _assert_context(payload,attempt,item,session,task_id)
    _recheck_original_attempt(db,attempt)
    content = _canonical_content(payload)
    digest = canonical_digest({"context":context_dict(payload),"content":content})
    existing = db.scalar(select(SubmissionRecord).where(or_(SubmissionRecord.submission_id == payload.submission_id,SubmissionRecord.attempt_id == attempt.id,SubmissionRecord.run_id == attempt.run_id)).execution_options(populate_existing=True))
    if existing is not None:
        if context_dict(existing) != context_dict(payload) or existing.canonical_digest != digest:
            raise HTTPException(409,"The attempt/run already contains different immutable submission content.")
        response = ack_response(db,existing)
        append_submission_audit(db,patient_id=patient.id,actor_user_id=user.id,result_kind=existing.kind,result_id=response.result["id"],digest=digest,submission_id=payload.submission_id,action="submission_retry_ack")
        db.commit()
        mark_transaction_audit_committed(db)
        return response,False
    _guard_active_context(db,session,item=item,attempt=attempt)
    if attempt.execution_status != "in_progress":
        raise HTTPException(409,"This attempt is not currently in progress.")
    try:
        record,quality,reasons,comparison,completion = _result(db,patient,item,attempt,session,content)
        status_snapshot = {"execution_status":"submitted", "quality_status":quality, "quality_reasons":reasons,
            "quality_rule_version":RULE_VERSION, "comparability_status":"not_verified", "comparability_reasons":comparison,
            "acceptance_status":"not_required" if session.source == "self" else "pending_review", "authorization_snapshot":authorization_snapshot(db)}
        row = SubmissionRecord(**context_dict(payload),canonical_digest=digest,content=content,
            execution_metadata={"context_snapshot":context_dict(payload),"result_ref":{"kind":item.kind,"id":record.id},
                "completion":completion,"submission_snapshot":status_snapshot},
            scale_result_id=record.id if item.kind == "scale" else None,cognitive_result_id=record.id if item.kind == "cognitive" else None,
            **status_snapshot)
        db.add(row)
        db.flush()
        ready,version = _advance(db,attempt,item,session,quality)
        append_care_event(db,patient_id=patient.id,actor_user_id=user.id,event_type="submission_committed",aggregate_type="submission",aggregate_id=row.id,revision=1,payload={"submission_id":row.submission_id,"attempt_id":attempt.id,"assessment_id":session.id,"canonical_digest":digest,"quality_status":quality,"authorization_snapshot":row.authorization_snapshot},dedupe_key="submission:"+row.submission_id,consumers=("assessment_progress",))
        if quality in {"limited", "invalid"}:
            append_care_event(db,patient_id=patient.id,actor_user_id=user.id,event_type="assessment_quality_issue",aggregate_type="submission",aggregate_id=row.id,revision=1,
                payload={"submission_id":row.submission_id,"attempt_id":attempt.id,"assessment_id":session.id,"assessment_item_id":item.id,
                    "assessment_version":version,"quality_status":quality,"quality_reasons":reasons,"quality_rule_version":RULE_VERSION,
                    "responsible_doctor_id":session.responsible_doctor_id,"authorization_snapshot":row.authorization_snapshot},
                dedupe_key="assessment_quality:"+row.submission_id,consumers=("assessment_quality_attention",))
        if ready:
            append_care_event(db,patient_id=patient.id,actor_user_id=user.id,event_type="assessment_evidence_ready",aggregate_type="assessment",aggregate_id=session.id,revision=version,payload={"assessment_id":session.id,"source":session.source,"responsible_doctor_id":session.responsible_doctor_id,"assessment_version":version,"authorization_snapshot":row.authorization_snapshot},dedupe_key=f"assessment_ready:{session.id}:{version}",consumers=("assessment_evidence_ready",))
        append_submission_audit(db,patient_id=patient.id,actor_user_id=user.id,result_kind=item.kind,result_id=record.id,digest=digest,submission_id=row.submission_id)
        db.commit()
        mark_transaction_audit_committed(db)
    except IntegrityError as exc:
        db.rollback()
        existing = db.scalar(select(SubmissionRecord).where(SubmissionRecord.submission_id == payload.submission_id))
        if not existing or context_dict(existing) != context_dict(payload) or existing.canonical_digest != digest:
            raise HTTPException(409,"Concurrent submission context/content conflict.") from exc
        return ack_response(db,existing),False
    db.refresh(row)
    return ack_response(db,row),True


def get_submission(db,user,submission_id):
    row = db.scalar(select(SubmissionRecord).where(SubmissionRecord.submission_id == submission_id))
    if row is None:
        raise HTTPException(404,"Submission not found.")
    require_patient_access(db,user,row.patient_id,"assessment")
    session = db.get(AssessmentSession,row.assessment_id)
    _require_visible(session,user)
    from backend.app.services.security_service import _append_audit_log
    try:
        _append_audit_log(db,action="data_read",status="success",message="提交状态访问权限已核验。",patient_id=row.patient_id,actor_user_id=user.id,detail_json={"submission_id":row.submission_id,"scope":"assessment","result_kind":row.kind})
        db.commit()
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(503,"Critical access audit is unavailable; evidence is withheld.") from exc
    return ack_response(db,row)


def get_evidence(db,user,submission_id):
    ack = get_submission(db,user,submission_id)
    row = db.scalar(select(SubmissionRecord).where(SubmissionRecord.submission_id == submission_id))
    if row.kind == "scale":
        result = db.get(ScaleResult,row.scale_result_id)
        server_result = {"kind":"scale","id":result.id,"scale_type":result.scale_type,"score_json":result.score_json,"total_score":result.total_score,"risk_level":result.risk_level,"legacy":result.legacy}
    else:
        result = db.get(CognitiveTest,row.cognitive_result_id)
        server_result = {"kind":"cognitive","id":result.id,"test_type":result.test_type,"result_json":result.result_json,"legacy":result.legacy}
    return {"submission_id":row.submission_id,"context":context_dict(row),"client_evidence":row.content,"execution_metadata":row.execution_metadata["completion"],"server_result":server_result,"ack":ack.model_dump(),"storage_integrity":{"format":"aesgcm:v2","status":row.envelope_status,"data_version":row.data_version},"demonstration_only":True}
