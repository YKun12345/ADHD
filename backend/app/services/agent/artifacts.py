"""Rule summaries retain actual sources and missing values, never clinical approval."""
from backend.app.services.agent.validators import validate_tool, source_refs, validate_artifact
from fastapi import HTTPException
import json
from backend.app.services.agent.tools import candidates

RULES_VERSION = 'W08-business-rules-2'
INTENT_TO_TOOL = {'question': 'get_progress', 'assessment_summary': 'draft_assessment_summary', 'cycle_summary': 'draft_cycle_summary',
    'review_questions': 'draft_review_questions', 'plan_draft': 'draft_plan', 'reply_draft': 'draft_reply', 'profile_fields': 'draft_profile_fields'}


def execute_tool(frame, name, arguments, *, request=None):
    validate_tool(frame, name, arguments)
    if name in {'draft_review_questions', 'draft_plan', 'draft_reply'}:
        from backend.app.services.agent.doctor_drafts import scoped_frame
        frame = scoped_frame(frame, arguments.get('assessment_id'))
    sessions = [row for row in frame['assessments'] if arguments.get('assessment_id') in {None, row['id']}]
    cycles = [row for row in frame['cycles'] if arguments.get('cycle_id') in {None, row['id']}]
    if name == 'get_current_tasks':
        return {'assessment_items': [{'assessment_id': row['id'], 'items': row['items']} for row in sessions],
            'plan_tasks': [task for row in frame['plans'] for task in row['tasks']]}
    if name == 'get_authorized_evidence':
        return {'submissions': [item for row in sessions for item in row['submissions']],
            'reports': [item for row in sessions for item in row['reports']], 'model_evidence_status': 'not_admitted'}
    if name == 'suggest_next_action':
        return {'actions': candidates(frame)}
    originals = [item for row in sessions for item in row['submissions']]
    item_ids = {item['id'] for row in sessions for item in row['items']}
    submitted = {item['assessment_item_id'] for item in originals}
    summary = {'assessment_count': len(sessions), 'applicable_items': len(item_ids), 'submitted_items': len(submitted),
        'missing_items': len(item_ids - submitted), 'valid_submissions': sum(item['quality_status'] == 'valid' for item in originals),
        'limited_submissions': sum(item['quality_status'] == 'limited' for item in originals),
        'invalid_submissions': sum(item['quality_status'] == 'invalid' for item in originals),
        'cycle_summaries': [{'cycle_id': row['id'], 'cycle_type': row['cycle_type'], 'processing_status': row['processing_status'],
            'actual_coverage': row['summary'], 'interpretation': '记录覆盖情况，不是治疗效果。'} for row in cycles]}
    result = {'summary': summary, 'source_refs': source_refs(frame)}
    if name == 'draft_cycle_summary':
        lines = [f"周期 {row['id']}（{row.get('start_date', '日期待核对')} 至 {row.get('end_date', '日期待核对')}）："
            f"截至 {row['summary'].get('as_of_date', frame.get('as_of_date', '当前'))}，"
            f"实际记录 {row['summary'].get('completed_count', '待核对')} / {row['summary'].get('due_count', '待核对')} 天。"
            for row in cycles]
        result['cycle_draft'] = {'cycle_id': arguments.get('cycle_id'),
            'text': '\n'.join(lines) + '\n缺失日期保持未记录；这里只说明实际记录覆盖，不能判断治疗效果或替代阶段决定。'}
    elif name in {'draft_review_questions', 'draft_plan', 'draft_reply'}:
        from backend.app.services.agent.doctor_drafts import prepare
        result.update(prepare(frame, name))
    elif name == 'draft_profile_fields':
        try:
            fields = json.loads((request or {}).get('message', ''))
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, 'Choose specific background fields and provide their actual values before drafting.') from exc
        allowed = {'diagnosis_history', 'medication', 'other_conditions', 'sleep', 'school_work'}
        if not isinstance(fields, dict) or not fields or not set(fields) <= allowed:
            raise HTTPException(422, 'Only the actual optional background fields can be prepared.')
        copied = {}
        for key, value in fields.items():
            if not isinstance(value, dict) or set(value) != {'status', 'value'} or value['status'] not in {'provided', 'unknown', 'skipped'}:
                raise HTTPException(422, 'Background draft requires actual provided/unknown/skipped state.')
            if value['status'] == 'provided':
                if not isinstance(value['value'], str) or not value['value'].strip() or len(value['value']) > 1000:
                    raise HTTPException(422, 'Provided background needs the actual user text.')
            elif value['value'] is not None:
                raise HTTPException(422, 'Unknown or skipped background must stay null.')
            copied[key] = {**value, 'confirmed': False, 'source': 'actual_user_input', 'requires_user_confirmation': True}
        result['profile_draft'] = {'fields': copied, 'reason': '逐字保留本次用户输入；尚未逐项确认或写入背景资料。'}
    return result


def rule_artifact(frame, request):
    tool = INTENT_TO_TOOL[request['intent']]
    arguments = {'patient_id': frame['patient_id'], 'assessment_id': request.get('assessment_id'), 'cycle_id': request.get('cycle_id')}
    result = execute_tool(frame, tool, arguments, request=request)
    body = {'status': 'draft', 'requires_human_confirmation': True, 'model_evidence_status': 'not_admitted',
        'kind': request['intent'], **result,
        'reply': '已按当前获准且实际保存的业务记录核对。质量局限、缺失材料和未完成项目分别保留；下一步可打开对应评估、补问或已发布计划。规则摘要不能代替医生意见。'}
    if request['intent'] == 'question':
        from backend.app.services.agent.companion import answer_question
        body['question_topic'], body['reply'] = answer_question(frame, request, body['summary'])
    elif request['intent'] == 'profile_fields':
        body['reply'] = '已逐字整理你主动提供的背景。请逐项核对，不知道和跳过保持未知；确认后可带入新建评估，尚未保存背景。'
    elif request['intent'] == 'cycle_summary':
        body['reply'] = body['cycle_draft']['text']
    elif request['intent'] == 'reply_draft':
        body['reply'] = body['reply_draft']['text']
    elif request['intent'] == 'review_questions':
        lines = [row['question'] for row in body.get('questions', [])[:2]]
        lines += [row['suggested_question'] for row in body.get('missing_materials', [])[:4]]
        body['reply'] = '\n'.join(lines) if lines else '当前没有可根据实际原件准备的具体质量补问。可以先核对本轮材料，或说明需要沟通的具体困难。'
    from backend.app.services.ai_service import _is_high_risk_message, _high_risk_reply
    if _is_high_risk_message(request['message']):
        body['reply'] = _high_risk_reply()
    references = result['source_refs']; validate_artifact(frame, body, references)
    return body, references, 1
