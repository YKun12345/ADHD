"""Only server-owned targets and current business facts can produce an action."""
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy import select
from backend.app.models.agent import AgentAction, metadata
from backend.app.services.agent.context import build_context
from backend.app.services import assessment_service, review_service, care_plan_service
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.identity_access import self_access
from backend.app.services.attention_action_service import _original

TARGETS = frozenset({'assessments', 'doctor_review', 'review_questions', 'care_reports', 'patient_plan', 'doctor_plan', 'care_cycles', 'cycle_review', 'care_attention'})


def candidates(frame):
    result = []; doctor = frame['role'] == 'researcher'; pid = frame['patient_id']
    def add(kind, title, reason, page, params, source):
        if page not in TARGETS or any(key not in {'patient_id', 'assessment_id', 'cycle_id'} or type(value) is not int or value < 1 for key, value in params.items()):
            raise ValueError('Agent target is outside the fixed business whitelist.')
        result.append({'kind': kind, 'title': title, 'reason': reason, 'target': {'page_key': page, 'params': params}, 'source': source})
    for session in frame['assessments']:
        params = {'patient_id': pid, 'assessment_id': session['id']}
        source = {'assessment_id': session['id'], 'assessment_version': session['version'],
            'item_versions': [[item['id'], item['version']] for item in session['items']],
            'original_refs': [row['source_ref'] for row in session['submissions']]}
        active = session['status'] not in {'draft', 'suspended', 'cancelled', 'reviewed', 'closed_self'}
        if doctor and active and session['responsible_doctor_id'] == frame['actor_user_id'] and session['submissions']:
            add('review_assessment', '核对本轮实际材料', '已有真实提交；质量、局限和医生决定分别核对。', 'doctor_review', params, source)
        if not doctor and active:
            unanswered = [row for row in session['clarifications'] if not row['replies']]
            if unanswered:
                add('answer_questions', '查看医生的具体补问', '可以按实际情况提供、不知道或跳过，其他背景仍为选填。', 'review_questions', params,
                    {'assessment_id': session['id'], 'questions': [[row['id'], row['payload_digest']] for row in unanswered]})
            repeats = [item for item in session['items'] if item['repeat_request'] and
                (item['repeat_request']['available'] or item['repeat_request']['continuing_attempt_id'])]
            if repeats:
                add('repeat_requested', '查看医生指定的重测', repeats[0]['repeat_request']['reason'], 'assessments', params, source)
            elif any('create_attempt' in item['allowed_actions'] for item in session['items']):
                add('continue_assessment', '继续本轮评估', '以服务器保存状态为准；开始前确认实际执行者。', 'assessments', params, source)
        if session['reports']:
            report = max(session['reports'], key=lambda row: row['version'])
            add('read_report', '查看已发布医生意见', '读取实际发布的版本、局限和原始材料来源。', 'care_reports', params,
                {'assessment_id': session['id'], 'report_id': report['id'], 'version': report['version'], 'input_digest': report['input_digest']})
    for plan in frame['plans']:
        if not plan['versions']:
            continue
        latest = plan['versions'][-1]; params = {'patient_id': pid, 'assessment_id': plan['assessment_id']}
        source = {'plan_id': plan['id'], 'revision': plan['revision'], 'plan_version_id': latest['id'], 'payload_digest': latest['payload_digest']}
        received = any(row['plan_version_id'] == latest['id'] and row['actor_user_id'] == frame['actor_user_id'] for row in plan['receipts'])
        add('view_plan' if doctor or received else 'receive_plan' if plan['status'] == 'active' else 'view_paused_plan',
            '查看医生计划' if doctor or received else '阅读并确认收到计划' if plan['status'] == 'active' else '查看已暂停计划和历史',
            '收到与实际执行分别记录；原计划暂停后不会自动恢复。', 'doctor_plan' if doctor else 'patient_plan', params, source)
        if not doctor and plan['status'] == 'active':
            for task in plan['tasks']:
                if task['record_date'] == frame['as_of_date'] and task['status'] == 'pending':
                    add('record_today', '记录今天的实际情况', '缺失保留为空；保存后才计入实际记录。', 'care_cycles',
                        {'patient_id': pid, 'cycle_id': task['cycle_id']}, {**source, 'task_id': task['id'], 'record_date': task['record_date']})
        if latest['end_date'] < frame['as_of_date'] and plan['status'] == 'active':
            add('cycle_due', '核对到期周期与后续安排', '核对覆盖和缺失；未来调整或下一轮由实际负责医生确认。', 'cycle_review',
                {'patient_id':pid,'cycle_id':latest['cycle_id']}, source)
    for cycle in frame['cycles']:
        if not doctor and cycle['cycle_type'] == 'self' and cycle['processing_status'] == 'active' and cycle['end_date'] < frame['as_of_date']:
            add('self_cycle_due','核对自助周期与下一步','查看实际覆盖，可明确结束或建立独立后续周期。','cycle_review',
                {'patient_id':pid,'cycle_id':cycle['id']},{'cycle_id':cycle['id'],'summary':cycle['summary'],'records':cycle['records']})
    if frame['attention']:
        add('view_attention', '查看当前关注事项', '处理实际关注及其原件，不把查看当作已经解决。', 'care_attention', {'patient_id': pid},
            {'attention': [[row['id'], row['version'], row['status']] for row in frame['attention']]})
    if not result and 'assessment' in frame['authorized_scopes']:
        add('open_assessments', '查看当前评估与适用项目', '可用模板与操作以实际授权和准入状态为准。', 'assessments', {'patient_id': pid},
            {'assessment_refs': [row['source_ref'] for row in frame['assessments']]})
    return result[:12]


def _process(db, user, pid):
    if self_access(db, user.id, pid):
        assessment_service._own_processing(db, user, pid)
    else:
        assessment_service._doctor_processing(db, user, pid)


def _response(row):
    return {'id': row.id, 'patient_id': row.patient_id, 'actor_user_id': row.actor_user_id, **row.snapshot['action'],
        'action_digest': row.action_digest, 'created_at': metadata(row)['created_at'], 'status': 'available'}


@review_service.storage_boundary
def current_actions(db, user, patient_id):
    frame = build_context(db, user, patient_id)
    from backend.app.db.agent_migration import require_agent_schema
    require_agent_schema(db.connection())
    from backend.app.services.agent.companion_workflow import build_companion
    if not frame['processing_available']:
        companion, _ = build_companion(db, user, frame, [])
        return {'patient_id': patient_id, 'actor_user_id': user.id, 'items': [], 'mode': 'history_only',
            'input_digest': frame['input_digest'], 'companion': companion}
    _process(db, user, patient_id)
    authority = {'authorization_snapshot': assessment_service.authorization_snapshot(db), 'credential_snapshot': care_plan_service._credentials(db)}
    authority_digest = canonical_digest(authority); rows = []
    for value in candidates(frame):
        action_digest = canonical_digest(value); key = canonical_digest({'action': action_digest, 'authority': authority_digest})
        row = db.scalar(select(AgentAction).where(AgentAction.actor_user_id == user.id, AgentAction.patient_id == patient_id, AgentAction.dedupe_key == key))
        if row is None:
            row = AgentAction(actor_user_id=user.id, patient_id=patient_id, kind=value['kind'], action_digest=action_digest,
                authority_digest=authority_digest, dedupe_key=key, created_at=datetime.now(timezone.utc).replace(microsecond=0))
            row.snapshot = {'metadata': metadata(row), 'action': value, 'authority': authority}; db.add(row); db.flush()
        rows.append(row)
    companion, rows = build_companion(db, user, frame, rows)
    result = [_response(row) for row in rows]
    review_service._audit(db, user, patient_id, 'agent_next_actions', {'count': len(result), 'input_digest': frame['input_digest']})
    return {'patient_id': patient_id, 'actor_user_id': user.id, 'items': result, 'mode': 'rules',
        'input_digest': frame['input_digest'], 'companion': companion}


@review_service.storage_boundary
def resolve_action(db, user, identifier, payload):
    from backend.app.schemas.agent import AgentActionResolve
    payload = review_service._validate(AgentActionResolve, payload)
    ref = db.execute(select(AgentAction.actor_user_id, AgentAction.patient_id).where(AgentAction.id == identifier)).first()
    if ref is None:
        raise HTTPException(404, 'Agent action not found.')
    if ref.actor_user_id != user.id:
        raise HTTPException(403, 'This action belongs to another actual actor.')
    if payload.patient_id != ref.patient_id:
        raise HTTPException(409, 'This action belongs to a different patient profile.')
    frame = build_context(db, user, ref.patient_id)
    row = db.get(AgentAction, identifier, populate_existing=True)
    if payload.expected_action_digest != row.action_digest:
        raise HTTPException(409, 'This action is not the original displayed action.')
    _original(db, row.snapshot['authority']['authorization_snapshot'])
    credentials = row.snapshot['authority']['credential_snapshot']
    if credentials:
        care_plan_service._original_credentials(db, credentials)
    if not frame['processing_available'] or not any(canonical_digest(value) == row.action_digest for value in candidates(frame)):
        raise HTTPException(409, 'This next action is out of date; refresh the current business state.')
    review_service._audit(db, user, ref.patient_id, 'agent_action_resolved', {'action_id': row.id, 'action_digest': row.action_digest})
    return {'action_id': row.id, 'patient_id': row.patient_id, 'target': row.snapshot['action']['target'],
        'action_digest': row.action_digest, 'revalidated': True}
