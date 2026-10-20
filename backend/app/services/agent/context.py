"""Business objects are authoritative; private chat and raw inputs are excluded."""
from datetime import datetime
from zoneinfo import ZoneInfo
from fastapi import HTTPException
from sqlalchemy import select
from backend.app.models.patient import Patient
from backend.app.models.user import User
from backend.app.models.submission import SubmissionRecord
from backend.app.models.scale_result import ScaleResult
from backend.app.models.review import ReportVersion
from backend.app.services import assessment_service, review_service, clarification_service, care_plan_service, attention_service
from backend.app.services import care_cycle_service
from backend.app.services import authorization_ledger
from backend.app.services.identity_access import self_access, require_doctor, require_patient_access, record_authenticated_actor
from backend.app.services.submission_service import _verify_record
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.deferred_read_audit import finish_reads_before_audits


def _role(user):
    return getattr(user.role, 'value', user.role)


def _scopes(db, user, patient_id):
    allowed = []
    for scope in ('assessment', 'care', 'tracking', 'profile'):
        previous = list(db.info.get('authorization_receipts') or [])
        try:
            require_patient_access(db, user, patient_id, scope)
            allowed.append(scope)
        except HTTPException as exc:
            if exc.status_code != 403:
                raise
            db.info['authorization_receipts'] = previous
            request = db.info.get('authorization_request')
            if request is not None:
                request.state.authorization_receipts = previous
    return allowed


def _can_process(user_id, patient_id):
    # Eligibility is a hint. Read receipts must never inherit processing checks
    # that would deny legal historical access after a basic-use withdrawal.
    from backend.app.db.session import SessionLocal
    with SessionLocal() as checker:
        user = checker.get(User, user_id)
        try:
            if self_access(checker, user_id, patient_id):
                assessment_service._own_processing(checker, user, patient_id)
            else:
                assessment_service._doctor_processing(checker, user, patient_id)
            return True
        except HTTPException as exc:
            if exc.status_code not in {403, 409}:
                raise
            return False


def _submission(db, row):
    _verify_record(db, row)
    score = None
    if row.scale_result_id is not None:
        result = db.get(ScaleResult, row.scale_result_id)
        score = result.total_score
    return {'submission_id': row.submission_id, 'assessment_item_id': row.assessment_item_id, 'attempt_id': row.attempt_id,
        'kind': row.kind, 'quality_status': row.quality_status, 'quality_reasons': list(row.quality_reasons),
        'quality_rule_version': row.quality_rule_version, 'original_acceptance_status': row.acceptance_status,
        'comparability_status': row.comparability_status, 'comparability_reasons': list(row.comparability_reasons),
        'system_score': score, 'canonical_digest': row.canonical_digest,
        'source_ref': f'submission:{row.submission_id}:{row.canonical_digest}'}


@review_service.storage_boundary
@authorization_ledger.read_heads()
@finish_reads_before_audits
def build_context(db, user, patient_id):
    role = _role(user)
    if role not in {'patient', 'researcher'}:
        raise HTTPException(403, 'This account has no patient or clinical Agent workspace.')
    record_authenticated_actor(db, user)
    if not self_access(db, user.id, patient_id):
        if role != 'researcher':
            raise HTTPException(403, 'This profile is outside the current lawful self/guardian identity.')
        require_doctor(db, user.id)
    scopes = _scopes(db, user, patient_id)
    if not scopes:
        raise HTTPException(403, 'No current lawful business scope is available for this profile.')
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(404, 'Patient profile not found.')
    own = bool(self_access(db, user.id, patient_id))
    frame = {'context_version': 1, 'actor_user_id': user.id, 'role': role, 'patient_id': patient_id,
        'subject_kind': getattr(patient.patient_type, 'value', patient.patient_type), 'authorized_scopes': scopes,
        'processing_available': _can_process(user.id, patient_id),
        'calendar_timezone': 'Asia/Shanghai', 'as_of_date': datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat(),
        'assessments': [], 'plans': [], 'cycles': [], 'attention': [], 'model_evidence_status': 'not_admitted',
        'raw_imaging_included': False, 'raw_evidence_included': False}
    if 'assessment' in scopes:
        visible = assessment_service.list_assessments(db, user, patient_id)['items']
        for value in visible:
            session = value.model_dump(mode='json')
            summary = {key: session[key] for key in ('id', 'patient_id', 'source', 'responsible_doctor_id', 'status', 'version',
                'suspension_reason', 'template_id', 'template_version', 'template_digest', 'demonstration_only', 'age_group')}
            summary['items'] = [{key: item[key] for key in ('id', 'key', 'kind', 'title', 'execution_status', 'quality_status',
                'acceptance_status', 'version', 'allowed_actions', 'repeat_request')} for item in session['items']]
            rows = db.scalars(select(SubmissionRecord).where(SubmissionRecord.assessment_id == session['id'],
                SubmissionRecord.patient_id == patient_id).order_by(SubmissionRecord.id)).all()
            summary['submissions'] = [_submission(db, row) for row in rows]
            summary['source_ref'] = f'assessment:{session["id"]}:{session["version"]}'
            try:
                questions = clarification_service.list_questions(db, user, session['id'])['items']
                summary['clarifications'] = [{'id': row['id'], 'source_type': row['source_type'], 'source_key': row['source_key'],
                    'question': row['question'], 'actor_user_id': row['actor_user_id'], 'payload_digest': row['payload_digest'],
                    'replies': [{key: reply[key] for key in ('id', 'revision', 'answer_status', 'actor_user_id', 'payload_digest')} for reply in row['replies']]} for row in questions]
                summary['clarifications_visibility'] = 'authorized'
            except HTTPException as exc:
                if exc.status_code not in {403, 409}:
                    raise
                summary['clarifications'] = []; summary['clarifications_visibility'] = 'not_authorized'
            # Published versions use their own access service. An authorized
            # assessment list never grants another doctor's private draft access.
            try:
                reports = review_service.list_reports(db, user, session['id'])['items']
                summary['reports'] = [{key: row[key] for key in ('id', 'version', 'category', 'actor_user_id',
                    'body', 'limitations', 'input_digest', 'published_at', 'demonstration_only')} for row in reports]
                summary['reports_visibility'] = 'authorized'
            except HTTPException as exc:
                if exc.status_code not in {403, 409}:
                    raise
                summary['reports'] = []; summary['reports_visibility'] = 'not_authorized'
            frame['assessments'].append(summary)
    if {'assessment', 'tracking'}.issubset(scopes):
        for plan in care_plan_service.list_plans(db, user, patient_id)['items']:
            frame['plans'].append({key: plan[key] for key in ('id', 'patient_id', 'assessment_id', 'responsible_doctor_id',
                'status', 'revision', 'suspension_reason', 'current_plan_version_id')} | {
                'versions': [{key: version[key] for key in ('id', 'version', 'title', 'instructions', 'start_date', 'end_date',
                    'cycle_id', 'payload_digest', 'demonstration_only')} for version in plan['versions']],
                'tasks': [{key: task[key] for key in ('id', 'plan_version_id', 'record_date', 'cycle_id', 'status', 'daily_record_id')} for task in plan['tasks']],
                'receipts': [{key: receipt[key] for key in ('id', 'plan_version_id', 'actor_user_id', 'meaning')} for receipt in plan['acknowledgements']]})
    if 'care' in scopes:
        try:
            attention = attention_service.patient_attention(db, user, patient_id, commit=False) if own else attention_service.doctor_work_queue(db, user, patient_id=patient_id, commit=False)
            frame['attention'] = [{key: row[key] for key in ('id', 'patient_id', 'assessment_id', 'kind', 'status', 'version',
                'responsible_doctor_id', 'suspension_reason')} for row in attention['items'] if row['patient_id'] == patient_id]
        except HTTPException as exc:
            if exc.status_code not in {403, 409}:
                raise
            frame['attention_visibility'] = 'not_authorized'
    if 'tracking' in scopes:
        cycles = care_cycle_service.list_cycles(db, user, patient_id)['items']
        for item in cycles:
            cycle = care_cycle_service.get_cycle(db, user, item['id'])
            frame['cycles'].append({key: cycle[key] for key in ('id', 'patient_id', 'cycle_type', 'start_date', 'end_date',
                'plan_version_id', 'responsible_doctor_id', 'processing_status', 'suspension_reason', 'summary')} | {
                'records': [{key: record[key] for key in ('record_id', 'record_date', 'revision', 'content_digest', 'actor_user_id')} for record in cycle['records']]})
    frame['input_digest'] = canonical_digest(frame)
    frame['authorization_snapshot'] = assessment_service.authorization_snapshot(db)
    frame['credential_snapshot'] = care_plan_service._credentials(db)
    review_service._audit(db, user, patient_id, 'data_read', {'scope': 'unified_agent_context', 'input_digest': frame['input_digest']})
    return frame
