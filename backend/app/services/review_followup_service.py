"""Follow-up requests derive from actual immutable published decisions only."""
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from backend.app.models.review import ReportVersion
from backend.app.models.assessment import TaskAttempt


def repeat_state(db, session):
    if session.source != 'doctor_assigned':
        return {}, {}
    try:
        reports = db.scalars(select(ReportVersion).where(ReportVersion.assessment_id == session.id)
            .order_by(ReportVersion.version)).all()
    except DBAPIError as exc:
        raise HTTPException(503, 'Review follow-up storage requires an explicit upgrade before processing.') from exc
    latest, barriers = {}, {}
    for report in reports:
        for decision in report.snapshot['ack']['decisions']:
            item_id = decision['assessment_item_id']
            if decision['decision'] == 'needs_repeat':
                barriers[item_id] = max(barriers.get(item_id, 0), decision['attempt_id'])
            previous = latest.get(item_id)
            if previous is None or (report.version, decision['attempt_id']) > (previous[0].version, previous[1]['attempt_id']):
                latest[item_id] = (report, decision)
    attempts = db.scalars(select(TaskAttempt).where(TaskAttempt.assessment_id == session.id).order_by(TaskAttempt.id)).all()
    result = {}
    for item_id, (report, decision) in latest.items():
        if decision['decision'] != 'needs_repeat':
            continue
        successors = [attempt for attempt in attempts if attempt.assessment_item_id == item_id and
            (attempt.execution_metadata.get('repeat_request') or {}).get('source_attempt_id') == decision['attempt_id'] and
            (attempt.execution_metadata.get('repeat_request') or {}).get('report_id') == report.id]
        continuing = next((attempt.id for attempt in successors if attempt.execution_status == 'in_progress'), None)
        result[item_id] = {'report_id': report.id, 'report_version': report.version, 'source_attempt_id': decision['attempt_id'],
            'source_submission_id': decision['submission_id'], 'assessment_item_id': item_id, 'patient_id': session.patient_id,
            'assessment_id': session.id, 'doctor_user_id': report.actor_user_id, 'reason': decision['reason'],
            'requested_at': report.snapshot['ack']['published_at'], 'available': not successors, 'continuing_attempt_id': continuing}
    return result, barriers


def authorize_repeat(db, session, item, *, report_id=None, attempt=None):
    requests, _ = repeat_state(db, session)
    request = requests.get(item.id)
    if request is None:
        raise HTTPException(409, 'This item has no current published request for a new repeat.')
    if attempt is None:
        if not request['available'] or report_id != request['report_id']:
            raise HTTPException(409, 'Select the exact published repeat request, or continue its existing attempt.')
    else:
        original = attempt.execution_metadata.get('repeat_request')
        if not original or any(original.get(key) != request[key] for key in ('report_id', 'source_attempt_id', 'assessment_item_id')):
            raise HTTPException(409, 'This attempt is not the actual successor of the current repeat request.')
    from backend.app.services.attention_action_service import _original
    report = db.get(ReportVersion, request['report_id'])
    _original(db, report.snapshot['authorization_snapshot'])
    return request
