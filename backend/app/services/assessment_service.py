"""Versioned reference assessments with actual execution and submission state."""
from copy import deepcopy
from datetime import datetime, timezone
import json

from fastapi import HTTPException
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError

from backend.app.core.config import settings
from backend.app.models.assessment import AssessmentSession, AssessmentItem, TaskAttempt
from backend.app.models.patient_task import PatientTask, PatientTaskStatus, PatientTaskType
from backend.app.models.patient import Patient
from backend.app.models.identity import CareRelationship
from backend.app.models.user import User
from backend.app.schemas.assessment import AssessmentItemResponse, AssessmentSessionResponse, TaskAttemptResponse
from backend.app.services.assessment_templates import select_template, registry_response, reference_enabled, USAGE_NOTICE
from backend.app.services.cognitive_contract import validate_formal_attempt_source
from backend.app.services.identity_access import require_patient_access, require_processing_access, require_doctor, self_access

SUBMISSION_BLOCKERS = ["formal_report_and_clinical_admission_not_approved"]


def authorization_snapshot(db):
    return json.loads(json.dumps(db.info.get("authorization_receipts", []), default=lambda value:value.isoformat()))


def template_response(db,user,patient):
    response = registry_response(patient)
    previous_processing = db.info.get("requires_basic_use",False)
    can_self = can_doctor = background_allowed = False
    try:
        for source,operation in (("self",_own_processing),("doctor",_doctor_processing)):
            try:
                operation(db,user,patient.id)
                if source == "self":
                    can_self = True
                else:
                    can_doctor = True
            except HTTPException as exc:
                if exc.status_code != 403:
                    raise
        if can_self or can_doctor:
            try:
                require_processing_access(db,user,patient.id,{"assessment","profile"})
                background_allowed = True
            except HTTPException as exc:
                if exc.status_code != 403:
                    raise
    finally:
        db.info["requires_basic_use"] = previous_processing
    executable = reference_enabled() and bool(response["items"])
    response.update({"can_create":executable and (can_self or can_doctor), "can_create_self":executable and can_self, "can_create_doctor_assigned":executable and can_doctor, "background_processing_allowed":executable and background_allowed})
    for template in response["items"]:
        template.update({key:response[key] for key in ("can_create","can_create_self","can_create_doctor_assigned","background_processing_allowed")})
    return response


def _own_processing(db, user, patient_id):
    patient = require_processing_access(db, user, patient_id, "assessment")
    if not self_access(db, user.id, patient_id):
        raise HTTPException(403, "Only the actual self user or verified primary guardian can start an assessment attempt.")
    return patient


def _doctor_processing(db, user, patient_id, *, relationship_id=None):
    require_doctor(db, user.id)
    db.info["requires_basic_use"] = True
    candidates = [relationship_id] if relationship_id is not None else db.scalars(select(CareRelationship.id).where(CareRelationship.patient_id == patient_id,CareRelationship.doctor_user_id == user.id,CareRelationship.status == "active").order_by(CareRelationship.id)).all()
    for candidate in candidates:
        try:
            # Explicit relationship prevents a qualified doctor's self access
            # from standing in for mutually confirmed clinical sharing.
            return require_patient_access(db,user,patient_id,{"assessment","care"},relationship_id=candidate)
        except HTTPException as exc:
            if exc.status_code != 403:
                raise
    raise HTTPException(403,"The original, mutually confirmed clinical relationship and assessment/care processing authority are required.")


def _bound_relationship(row):
    for actor_id,patient_id,scope,purpose,versions in row.authorization_snapshot:
        if actor_id == row.responsible_doctor_id and patient_id == row.patient_id:
            identifier = next((identifier for table,key,revision,identifier in versions if table == "care_relationships"),None)
            if identifier is not None:
                return identifier
    raise HTTPException(403,"This doctor's assessment has no original clinical relationship authority.")


def _load(db, identifier):
    row = db.get(AssessmentSession, identifier)
    if row is None:
        raise HTTPException(404, "Assessment not found.")
    return row


def _require_visible(row,user):
    if row.source == "doctor_assigned" and row.published_at is None and row.responsible_doctor_id != user.id:
        raise HTTPException(403,"An unpublished doctor assessment is private to its actual responsible doctor.")


def _guard_active_context(db, row, *, item=None, attempt=None, repeat_report_id=None, check_only=False):
    if row.status not in {"active", "under_review"}:
        raise HTTPException(409, "The assessment is not currently active.")
    patient = db.get(Patient, row.patient_id)
    template = select_template(row.template_id, row.template_version, patient)
    if template["template_digest"] != row.template_digest:
        raise HTTPException(409, "Frozen template no longer matches this assessment.")
    if row.source == "doctor_assigned":
        _doctor_processing(db, db.get(User, row.responsible_doctor_id), row.patient_id,relationship_id=_bound_relationship(row))
        from backend.app.services.attention_action_service import _original
        _original(db, row.authorization_snapshot)
        if not check_only:
            from backend.app.services.review_followup_service import repeat_state, authorize_repeat
            requests, _ = repeat_state(db, row)
            if row.status == 'under_review' or repeat_report_id is not None or (item is not None and item.id in requests):
                if item is None:
                    raise HTTPException(409, 'Select the exact item requested for repeat.')
                authorize_repeat(db, row, item, report_id=repeat_report_id, attempt=attempt)
    return template


def _commit(db):
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "Concurrent assessment change; refresh the current server version.") from exc


def create_assessment(db, user, payload, source, *, commit=True):
    patient = _own_processing(db, user, payload.patient_id) if source == "self" else _doctor_processing(db, user, payload.patient_id)
    if any(field.status == "provided" for field in payload.background.values()):
        require_processing_access(db,user,patient.id,{"assessment","profile"})
    adoption_digest=None
    if payload.source_ai_decision_id is not None:
        require_processing_access(db,user,patient.id,{'assessment','profile'})
        from backend.app.models.agent import AIArtifact,ArtifactDecision
        from backend.app.services.agent.artifact_decision_service import validate_adoption
        from backend.app.services.cognitive_contract import canonical_digest
        origin=db.get(ArtifactDecision,payload.source_ai_decision_id)
        if origin is None: raise HTTPException(404,'The source background confirmation does not exist.')
        if origin.actor_user_id!=user.id: raise HTTPException(403,'The background confirmation belongs to another actual actor.')
        # Serialize both creation and retries against later human decisions.
        db.execute(update(AIArtifact).where(AIArtifact.id==origin.artifact_id).values(id=AIArtifact.id))
        adoption_digest=canonical_digest(payload.model_dump(mode='json'))
        previous_rows=db.scalars(select(AssessmentSession).where(AssessmentSession.patient_id==patient.id,
            AssessmentSession.created_by_user_id==user.id).order_by(AssessmentSession.id)).all()
        for previous_row in previous_rows:
            provenance=next((field for field in previous_row.background.values() if field.get('source_ai_decision_id')==payload.source_ai_decision_id),None)
            if provenance is not None:
                if provenance.get('source_ai_request_digest')!=adoption_digest or previous_row.source!=source:
                    raise HTTPException(409,'The original adopted background was already saved with different business input.')
                from backend.app.services.attention_action_service import _original
                _original(db,previous_row.authorization_snapshot)
                return session_response(db,previous_row,user)
        if not payload.background or any(not field.confirmed for field in payload.background.values()):
            raise HTTPException(422,'Confirm each adopted background field again in the actual assessment form.')
        validate_adoption(db,user,payload.source_ai_decision_id,target_type='assessment_background',client_id=payload.client_assessment_id,
            patient_id=patient.id,content={'fields':{key:{'status':field.status,'value':field.value} for key,field in payload.background.items()}})
    template = select_template(payload.template_id, payload.template_version, patient)
    if payload.previous_assessment_id is not None:
        previous = _load(db, payload.previous_assessment_id)
        require_patient_access(db, user, previous.patient_id, "assessment")
        _require_visible(previous,user)
        if previous.patient_id != patient.id:
            raise HTTPException(409, "A previous assessment must belong to the same patient.")
    background = {}
    for key, field in payload.background.items():
        if not key.strip() or len(key) > 64:
            raise HTTPException(422, "Invalid background field name.")
        required_source = "patient_report" if source == "doctor_assigned" else ("guardian_report" if self_access(db, user.id, patient.id).access_kind == "guardian" else "self_report")
        if field.source != required_source:
            raise HTTPException(422, "Background source does not match the actual current identity.")
        background[key] = {**field.model_dump(), "recorded_by_user_id":user.id, "confirmed_by_user_id":user.id if field.confirmed else None}
        if adoption_digest is not None:
            background[key].update(source_ai_decision_id=payload.source_ai_decision_id,source_ai_target_client_id=payload.client_assessment_id,
                source_ai_request_digest=adoption_digest)
    try:
        encoded = json.dumps(background, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, "Background must contain finite JSON values.") from exc
    if len(encoded.encode("utf-8")) > 65536:
        raise HTTPException(422, "Background exceeds the permitted record size.")
    row = AssessmentSession(patient_id=patient.id, source=source, responsible_doctor_id=None if source == "self" else user.id, created_by_user_id=user.id, template_id=template["id"], template_version=template["version"], template_digest=template["template_digest"], template_snapshot=deepcopy(template), age_at_assessment=patient.age, age_group=template["age_group"], previous_assessment_id=payload.previous_assessment_id, authorization_snapshot=authorization_snapshot(db), background=background, status="active" if source == "self" else "draft", version=1, demonstration_only=True)
    db.add(row)
    db.flush()
    for definition in template["items"]:
        db.add(AssessmentItem(assessment_id=row.id, patient_id=patient.id, key=definition["key"], kind=definition["kind"], instrument=definition["instrument"], definition_snapshot=deepcopy(definition), acceptance_status="not_required" if source == "self" else "pending_review"))
    if commit:
        _commit(db)
    else:
        db.flush()
    db.refresh(row)
    return session_response(db, row, user)


def publish_assessment(db, user, identifier, payload):
    row = _load(db, identifier)
    if row.source != "doctor_assigned" or row.responsible_doctor_id != user.id:
        raise HTTPException(403, "Only the actual responsible doctor can publish this assessment.")
    _doctor_processing(db, user, row.patient_id,relationship_id=_bound_relationship(row))
    patient = require_patient_access(db, user, row.patient_id, {"assessment", "care"})
    template = select_template(row.template_id, row.template_version, patient)
    if template["template_digest"] != row.template_digest:
        raise HTTPException(409, "The frozen template has changed.")
    if row.status != "draft" or row.version != payload.expected_version:
        raise HTTPException(409, "Assessment publication version/status conflict.")
    now = datetime.now(timezone.utc)
    changed = db.execute(update(AssessmentSession).where(AssessmentSession.id == row.id, AssessmentSession.version == payload.expected_version, AssessmentSession.status == "draft").values(status="active", version=payload.expected_version + 1, published_at=now))
    if changed.rowcount != 1:
        raise HTTPException(409, "Assessment was already published or modified.")
    items = db.scalars(select(AssessmentItem).where(AssessmentItem.assessment_id == row.id).order_by(AssessmentItem.id)).all()
    for item in items:
        definition = item.definition_snapshot
        db.add(PatientTask(patient_id=row.patient_id, researcher_id=user.id, assessment_id=row.id, assessment_item_id=item.id, legacy=False, task_type=PatientTaskType.SCALE if item.kind == "scale" else PatientTaskType.COGNITIVE, task_title=definition["title"], task_description="完成本轮参考评估；提交后由医生核对实际材料。", target_page="/pages/assessments/index", target_payload_json=json.dumps({"assessment_id":row.id, "assessment_item_id":item.id}), status=PatientTaskStatus.PENDING))
    _commit(db)
    db.refresh(row)
    return session_response(db, row, user)


def create_attempt(db, user, item_id, payload):
    item = db.get(AssessmentItem, item_id)
    if item is None:
        raise HTTPException(404, "Assessment item not found.")
    patient = _own_processing(db, user, item.patient_id)
    db.execute(update(AssessmentSession).where(AssessmentSession.id == item.assessment_id).values(version=AssessmentSession.version))
    row = db.get(AssessmentSession, item.assessment_id, populate_existing=True)
    item = db.get(AssessmentItem, item_id, populate_existing=True)
    _require_visible(row,user)
    _guard_active_context(db, row, item=item, repeat_report_id=payload.repeat_report_id)
    definition = item.definition_snapshot
    if payload.expected_item_version != item.version or item.execution_status == "cancelled":
        raise HTTPException(409, "Assessment item version/status conflict.")
    if (payload.protocol_id, payload.protocol_schema_version, payload.config_digest) != (definition["protocol_id"], definition["protocol_schema_version"], definition["config_digest"]):
        raise HTTPException(422, "Attempt protocol/schema/config must exactly match the published item.")
    if item.kind == "cognitive":
        try:
            validate_formal_attempt_source(payload.protocol_id,payload.protocol_schema_version,payload.device.platform)
        except ValueError as exc:
            raise HTTPException(422,str(exc)) from exc
    access = self_access(db, user.id, patient.id)
    required_respondent = definition["respondent_kind"]
    actual_patient_performer = patient.id if item.kind == "cognitive" else None
    if not payload.confirmed or payload.performer_patient_id != actual_patient_performer or payload.respondent_kind != required_respondent or payload.recall_window != definition["recall_window"]:
        raise HTTPException(422, "Actual performer/respondent/window confirmation does not match the applicable item.")
    if item.kind == "scale" and access.access_kind != ("guardian" if required_respondent == "primary_guardian" else "self"):
        raise HTTPException(422, "This scale requires the actual self user or verified primary guardian.")
    prior = db.scalar(select(func.count(TaskAttempt.id)).where(TaskAttempt.patient_id == patient.id, TaskAttempt.protocol_id == definition["protocol_id"], TaskAttempt.config_digest == definition["config_digest"]))
    last = db.scalar(select(TaskAttempt).where(TaskAttempt.patient_id == patient.id, TaskAttempt.protocol_id == definition["protocol_id"], TaskAttempt.config_digest == definition["config_digest"]).order_by(TaskAttempt.created_at.desc(),TaskAttempt.id.desc()))
    now = datetime.now(timezone.utc)
    metadata = {key:getattr(payload,key).model_dump() for key in ("device", "input", "timing", "practice", "assistance")}
    metadata.update({"confirmed":True, "server_started_at":now.isoformat(), "prior_started_attempt_count":prior, "prior_attempt_id":last.id if last else None, "retake_interval_seconds":(now - (last.created_at if last.created_at.tzinfo else last.created_at.replace(tzinfo=timezone.utc))).total_seconds() if last else None, "comparability_status":"not_verified"})
    if payload.repeat_report_id is not None:
        from backend.app.services.review_followup_service import authorize_repeat
        metadata['repeat_request'] = authorize_repeat(db, row, item, report_id=payload.repeat_report_id)
    changed = db.execute(update(AssessmentItem).where(AssessmentItem.id == item.id, AssessmentItem.version == payload.expected_item_version).values(
        version=payload.expected_item_version+1, execution_status="in_progress", quality_status='pending_validation',
        acceptance_status='not_required' if row.source == 'self' else 'pending_review'))
    if changed.rowcount != 1:
        raise HTTPException(409, "A concurrent attempt changed this item; refresh before starting.")
    attempt = TaskAttempt(assessment_id=row.id, assessment_item_id=item.id, patient_id=patient.id, actor_user_id=user.id, performer_patient_id=actual_patient_performer, performer_user_id=user.id if item.kind == "scale" else None, performer_kind="user" if item.kind == "scale" else "patient", respondent_user_id=user.id if item.kind == "scale" else None, respondent_kind=required_respondent, submitter_user_id=user.id, age_at_attempt=patient.age, age_group=patient.patient_type.value, protocol_id=definition["protocol_id"], protocol_schema_version=definition["protocol_schema_version"], config_digest=definition["config_digest"], config_snapshot=deepcopy(definition["config"]), template_digest=row.template_digest, execution_metadata=metadata, recall_window=definition["recall_window"], authorization_snapshot=authorization_snapshot(db), acceptance_status="not_required" if row.source == "self" else "pending_review", created_at=now)
    db.add(attempt)
    _commit(db)
    db.refresh(attempt)
    return attempt_response(attempt)


def attempt_response(row,db=None):
    values = {name:getattr(row,name) for name in TaskAttemptResponse.model_fields if name not in {"metadata","submission_id","result","quality_reasons"}}
    if db is not None:
        from backend.app.models.submission import SubmissionRecord
        submission = db.scalar(select(SubmissionRecord).where(SubmissionRecord.attempt_id == row.id))
        if submission is not None:
            values.update(submission_id=submission.submission_id,result={"kind":submission.kind,"id":submission.scale_result_id if submission.kind == "scale" else submission.cognitive_result_id,"legacy":False},quality_reasons=list(submission.quality_reasons))
    return TaskAttemptResponse(**values,metadata=deepcopy(row.execution_metadata))


def available_actions(row, user_id):
    """Eligibility hints never turn a historical read into new processing."""
    if not reference_enabled():
        return []
    from backend.app.db.session import SessionLocal
    with SessionLocal() as permission_db:
        user = permission_db.get(User,user_id)
        try:
            if row.status in {"active", "under_review"} and self_access(permission_db,user_id,row.patient_id):
                _own_processing(permission_db,user,row.patient_id)
                _guard_active_context(permission_db,row,check_only=True)
                return ["create_attempt"] if row.status == 'active' else ['repeat_attempt']
            if row.status == "draft" and row.responsible_doctor_id == user_id:
                _doctor_processing(permission_db,user,row.patient_id,relationship_id=_bound_relationship(row))
                return ["publish"]
        except HTTPException as exc:
            if exc.status_code not in {403,409,422}:
                raise
    return []


def session_response(db, row, user):
    # Background is its own profile scope. Assessment/care access cannot expose it.
    require_patient_access(db, user, row.patient_id, "assessment")
    _require_visible(row,user)
    background = deepcopy(row.background)
    visibility = "shared"
    if not self_access(db, user.id, row.patient_id):
        try:
            require_patient_access(db, user, row.patient_id, "profile")
        except HTTPException as exc:
            if exc.status_code != 403:
                raise
            background = {}
            visibility = "withheld"
    items = []
    actions = available_actions(row,user.id)
    from backend.app.services.review_followup_service import repeat_state
    repeats, _ = repeat_state(db, row)
    for item in db.scalars(select(AssessmentItem).where(AssessmentItem.assessment_id == row.id).order_by(AssessmentItem.id)).all():
        definition = item.definition_snapshot
        task_id = db.scalar(select(PatientTask.id).where(PatientTask.assessment_item_id == item.id))
        attempts = db.scalars(select(TaskAttempt).where(TaskAttempt.assessment_item_id == item.id).order_by(TaskAttempt.id)).all()
        repeat = repeats.get(item.id)
        can_start = item.execution_status != 'cancelled' and (
            bool(repeat and repeat['available']) and bool(set(actions) & {'create_attempt', 'repeat_attempt'})
            or repeat is None and 'create_attempt' in actions)
        items.append(AssessmentItemResponse(id=item.id, assessment_id=row.id, patient_id=row.patient_id, **{name:deepcopy(definition[name]) for name in ("key","kind","instrument","title","respondent_kind","protocol_id","protocol_schema_version","config_digest","config","recall_window","content_digest")}, execution_status=item.execution_status, quality_status=item.quality_status, acceptance_status=item.acceptance_status, version=item.version, patient_task_id=task_id, attempts=[attempt_response(attempt,db) for attempt in attempts], allowed_actions=["create_attempt"] if can_start else [], repeat_request=repeat))
    ai_source=next((field.get('source_ai_decision_id') for field in background.values() if field.get('source_ai_decision_id')),None)
    return AssessmentSessionResponse(**{name:getattr(row,name) for name in ("id","patient_id","source","responsible_doctor_id","created_by_user_id","template_id","template_version","template_digest","age_at_assessment","age_group","previous_assessment_id","status","suspension_reason","version","demonstration_only","authorization_snapshot","created_at","published_at")}, usage_notice=USAGE_NOTICE, background=background, background_visibility=visibility, source_ai_decision_id=ai_source, items=items, allowed_actions=["publish"] if "publish" in actions else [], blockers=list(SUBMISSION_BLOCKERS))


def get_assessment(db, user, identifier):
    return session_response(db, _load(db, identifier), user)


def list_assessments(db, user, patient_id=None):
    from backend.app.services.identity_access import authorized_patient_ids, doctor_qualification
    from backend.app.models.identity import PatientAccess
    if patient_id is not None:
        require_patient_access(db, user, patient_id, "assessment")
        ids = [patient_id]
    else:
        ids = [pid for pid in db.scalars(select(PatientAccess.patient_id).where(PatientAccess.user_id == user.id)).all() if self_access(db,user.id,pid)]
        if not ids or doctor_qualification(db,user.id):
            ids = sorted(set(ids).union(authorized_patient_ids(db,user.id,"assessment")))
    rows = db.scalars(select(AssessmentSession).where(AssessmentSession.patient_id.in_(ids),or_(AssessmentSession.source != "doctor_assigned",AssessmentSession.published_at.is_not(None),AssessmentSession.responsible_doctor_id == user.id)).order_by(AssessmentSession.id.desc())).all()
    return {"items":[session_response(db,row,user) for row in rows]}
