"""Private continuity hints; the current authorized frame and actions stay authoritative."""
from time import time_ns

from fastapi import HTTPException
from sqlalchemy import select

from backend.app.models.security import SecurityAuditLog
from backend.app.schemas.companion import AgentCompanionObservation
from backend.app.services import review_service
from backend.app.services.cognitive_contract import canonical_digest

PROTOCOL = 'Xingzai-flow-1'
_PURPOSE = 'agent_companion_observation'
_PRIORITIES = {'answer_questions': 0, 'repeat_requested': 1, 'receive_plan': 2, 'record_today': 3,
    'review_assessment': 4, 'continue_assessment': 5, 'cycle_due': 6, 'self_cycle_due': 6,
    'read_report': 7, 'view_plan': 8, 'view_paused_plan': 8, 'view_attention': 9, 'open_assessments': 10}


def _authority(frame):
    return canonical_digest({'role': frame['role'], 'authorized_scopes': sorted(frame['authorized_scopes']),
        'processing_available': frame['processing_available'],
        'authorization_snapshot': frame['authorization_snapshot'], 'credential_snapshot': frame['credential_snapshot']})


def _snapshot(frame):
    """Identifiers, versions and status only: never names, question text, report or record bodies."""
    result = {'assessments': {}, 'questions': {}, 'replies': {}, 'reports': {}, 'plans': {}, 'cycles': {}, 'records': {}, 'attention': {}}
    if not frame['processing_available']:
        return result
    for session in frame['assessments']:
        aid = session['id']
        result['assessments'][str(aid)] = {'version': session['version'], 'status': session['status'],
            'items': [[row['id'], row['version'], row['execution_status'], row['quality_status'], row['acceptance_status']]
                for row in session['items']]}
        for question in session['clarifications']:
            qid = question['id']
            result['questions'][str(qid)] = {'assessment_id': aid, 'digest': question['payload_digest']}
            for reply in question['replies']:
                # One latest revision per question makes an actual correction distinguishable from a new answer.
                previous = result['replies'].get(str(qid))
                if previous is None or reply['revision'] > previous['revision']:
                    result['replies'][str(qid)] = {'assessment_id': aid, 'id': reply['id'], 'revision': reply['revision'],
                        'answer_status': reply['answer_status'], 'digest': reply['payload_digest']}
        for report in session['reports']:
            result['reports'][str(report['id'])] = {'assessment_id': aid, 'version': report['version']}
    for plan in frame['plans']:
        current = next((row for row in plan['versions'] if row['id'] == plan['current_plan_version_id']), None)
        result['plans'][str(plan['id'])] = {'revision': plan['revision'], 'status': plan['status'],
            'version_id': plan['current_plan_version_id'], 'version': current['version'] if current else None,
            'assessment_id': plan['assessment_id']}
    for cycle in frame['cycles']:
        result['cycles'][str(cycle['id'])] = {'cycle_type': cycle['cycle_type'], 'status': cycle['processing_status'],
            'start_date': cycle['start_date'], 'end_date': cycle['end_date'], 'plan_version_id': cycle['plan_version_id']}
        for record in cycle['records']:
            key = f"{cycle['id']}:{record['record_date']}"
            previous = result['records'].get(key)
            if previous is None or record['revision'] > previous['revision']:
                result['records'][key] = {'id': record['record_id'], 'revision': record['revision'],
                    'cycle_id': cycle['id'], 'record_date': record['record_date'], 'digest': record['content_digest']}
    for row in frame['attention']:
        result['attention'][str(row['id'])] = {'version': row['version'], 'status': row['status']}
    return result


def _logs(db, user_id, patient_id, action):
    return select(SecurityAuditLog).where(SecurityAuditLog.actor_user_id == user_id,
        SecurityAuditLog.patient_id == patient_id, SecurityAuditLog.action == action,
        SecurityAuditLog.status == 'success').order_by(SecurityAuditLog.id.desc())


def _latest_observation(db, user_id, patient_id):
    # Only explicit, private confirmations are baselines. Ordinary GET audit entries cannot consume updates.
    log = db.scalar(_logs(db, user_id, patient_id, 'agent_companion_observed').limit(1))
    if log is None:
        return None
    try:
        value = review_service._decode(log.detail_json.get('observation_context'), _PURPOSE)
    except HTTPException:
        return None
    if value.get('protocol') != PROTOCOL or value.get('actor_user_id') != user_id or value.get('patient_id') != patient_id:
        return None
    if value.get('fingerprint') != canonical_digest(value.get('snapshot')):
        return None
    return value


def _resume(db, user, frame, rows):
    log = db.scalar(_logs(db, user.id, frame['patient_id'], 'agent_action_resolved').limit(1))
    if log is None:
        return None
    detail = log.detail_json
    # Match the real current immutable row and original digest, never a client-supplied target or old source.
    return next((row for row in rows if row.id == detail.get('action_id') and row.actor_user_id == user.id
        and row.patient_id == frame['patient_id'] and row.action_digest == detail.get('action_digest')
        and row.action_digest == canonical_digest(row.snapshot['action'])), None)


def _updates(current, previous):
    changes = []

    def add(kind, identifier, value, text):
        changes.append({'id': canonical_digest({'kind': kind, 'id': identifier, 'value': value}), 'text': text})

    # Compare only objects still present in the currently authorized frame. A missing object says nothing about completion.
    for qid, value in current['questions'].items():
        if previous['questions'].get(qid) != value:
            add('question', qid, value, f"评估 #{value['assessment_id']} 当前有新增可查看的补问 #{qid}，可按实际情况答复。")
    labels = {'provided': '已提供', 'unknown': '不知道', 'skipped': '已跳过'}
    for qid, value in current['replies'].items():
        if previous['replies'].get(qid) != value:
            status = labels.get(value['answer_status'], value['answer_status'])
            add('reply', qid, value, f"补问 #{qid} 已保存第 {value['revision']} 次答复，状态为“{status}”；具体内容以原答复为准。")
    for rid, value in current['reports'].items():
        if previous['reports'].get(rid) != value:
            add('report', rid, value, f"评估 #{value['assessment_id']} 已发布报告 #{rid} 第 {value['version']} 版，可查看意见与局限。")
    for pid, value in current['plans'].items():
        earlier = previous['plans'].get(pid)
        if earlier != value:
            if value['version'] is not None and (earlier is None or earlier['version_id'] != value['version_id']):
                text = f"计划 #{pid} 当前有已发布的第 {value['version']} 版；收到与实际执行分别记录。"
            else:
                labels_plan = {'active': '进行中', 'suspended': '已暂停', 'completed': '已结束'}
                text = f"计划 #{pid} 的状态已有变化，当前为“{labels_plan.get(value['status'], value['status'])}”，请查看实际安排。"
            add('plan', pid, value, text)
    for cid, value in current['cycles'].items():
        if previous.get('cycles', {}).get(cid) != value:
            label = '独立周期' if value['cycle_type'] == 'self' else '计划周期'
            add('cycle', cid, value, f"{label} #{cid} 的当前安排可核对：{value['start_date']} 至 {value['end_date']}，实际日期记录另外保存。")
    for key, value in current['records'].items():
        if previous['records'].get(key) != value:
            verb = '新增' if previous['records'].get(key) is None else '修订'
            add('record', key, value, f"周期 #{value['cycle_id']} 日期 {value['record_date']} 的实际记录已有{verb}（第 {value['revision']} 版）；缺失项目仍保持为空。")
    for aid, value in current['assessments'].items():
        earlier = previous['assessments'].get(aid)
        if earlier is None:
            add('assessment', aid, value, f"当前新增可查看的评估 #{aid}（第 {value['version']} 版），以本轮适用项目和实际保存状态为准。")
        elif earlier['status'] != value['status'] or earlier['items'] != value['items']:
            add('assessment', aid, value, f"评估 #{aid} 的实际项目或状态已有变化，当前版本为 {value['version']}，可回到本轮核对。")
    for aid, value in current['attention'].items():
        if previous['attention'].get(aid) != value:
            add('attention', aid, value, f"关注事项 #{aid} 的当前状态有变化；请核对事项原件，看到提示不表示已经处理。")
    return changes


def build_companion(db, user, frame, action_rows):
    """Return the companion and ordered current rows; no recursive call to actions or new business permissions."""
    rows = sorted(action_rows, key=lambda row: _PRIORITIES.get(row.kind, 20))
    resumed = _resume(db, user, frame, rows) if frame['processing_available'] else None
    if resumed is not None:
        rows.remove(resumed)
        rows.insert(0, resumed)
    snapshot = _snapshot(frame)
    fingerprint = canonical_digest(snapshot)
    prior = _latest_observation(db, user.id, frame['patient_id'])
    changes = _updates(snapshot, prior['snapshot']) if prior and prior.get('role') == frame['role'] and frame['processing_available'] else []
    if not frame['processing_available']:
        stage, title, summary = 'history_only', '查看已授权历史', '当前仅可查看获准历史；后续处理以最新授权和业务页面为准。'
    elif rows:
        value = rows[0].snapshot['action']
        stage, title, summary = rows[0].kind, value['title'], value['reason']
    else:
        stage, title, summary = 'current_state', '查看当前业务状态', '当前没有可办理的下一步，仍以评估、计划和记录的实际状态为准。'
    token = review_service._encode({'protocol': PROTOCOL, 'actor_user_id': user.id, 'patient_id': frame['patient_id'],
        'role': frame['role'], 'authority_digest': _authority(frame), 'snapshot': snapshot,
        'fingerprint': fingerprint, 'issued_at': time_ns()}, _PURPOSE)
    if len(token) > 131072:
        raise HTTPException(503, 'Companion observation exceeds the supported context size; use the original business pages.')
    return {'protocol': PROTOCOL, 'stage_key': stage, 'title': title, 'summary': summary,
        'resume_action_id': resumed.id if resumed else None, 'updates': changes,
        'fingerprint': fingerprint, 'observation_context': token}, rows


@review_service.storage_boundary
def acknowledge_observation(db, user, payload):
    payload = review_service._validate(AgentCompanionObservation, payload)
    displayed = review_service._decode(payload.observation_context, _PURPOSE)
    if displayed.get('actor_user_id') != user.id:
        raise HTTPException(403, 'This companion observation belongs to another actual actor.')
    if displayed.get('patient_id') != payload.patient_id:
        raise HTTPException(409, 'This companion observation belongs to a different patient profile.')
    if displayed.get('protocol') != PROTOCOL or displayed.get('fingerprint') != canonical_digest(displayed.get('snapshot')):
        raise HTTPException(409, 'The displayed companion observation is invalid; refresh the current business state.')
    from backend.app.services.agent.context import build_context
    frame = build_context(db, user, payload.patient_id)
    if displayed.get('role') != frame['role'] or displayed.get('authority_digest') != _authority(frame):
        raise HTTPException(409, 'The displayed companion observation uses earlier authority; refresh the current business state.')
    previous = _latest_observation(db, user.id, payload.patient_id)
    if previous is None or displayed['issued_at'] > previous['issued_at']:
        review_service._audit(db, user, payload.patient_id, 'agent_companion_observed',
            {'protocol': PROTOCOL, 'fingerprint': displayed['fingerprint'], 'observation_context': payload.observation_context})
    # Late/repeated confirmations do not move the private baseline backwards or observe newer business facts.
    return {'observed': True, 'fingerprint': displayed['fingerprint']}
