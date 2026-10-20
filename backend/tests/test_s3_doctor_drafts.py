"""Concrete local drafts over synthetic authorized business frames only."""
from copy import deepcopy
import json

import pytest
from fastapi import HTTPException


def actual_frame():
    return {
        'actor_user_id': 5, 'role': 'researcher', 'patient_id': 9,
        'subject_kind': 'adult', 'authorized_scopes': ['assessment', 'care', 'tracking'],
        'as_of_date': '2026-10-18', 'authorization_snapshot': [],
        'assessments': [{
            'id': 3, 'patient_id': 9, 'responsible_doctor_id': 5, 'status': 'under_review',
            'version': 8, 'source_ref': 'assessment:3:8',
            'items': [
                {'id': 11, 'title': '抑制控制任务', 'kind': 'cognitive', 'execution_status': 'submitted'},
                {'id': 12, 'title': '成人自评量表', 'kind': 'scale', 'execution_status': 'not_started'},
            ],
            'submissions': [{
                'submission_id': 'actual-task-original', 'assessment_item_id': 11, 'attempt_id': 17,
                'kind': 'cognitive', 'quality_status': 'limited', 'quality_reasons': ['execution_interrupted'],
                'source_ref': 'submission:actual-task-original:' + 'a' * 64,
            }],
            'clarifications': [], 'reports_visibility': 'authorized',
            'reports': [{
                'id': 21, 'version': 2, 'category': 'evidence_review', 'actor_user_id': 5,
                'input_digest': 'b' * 64, 'published_at': '2026-10-17T08:00:00Z',
                'body': '本轮任务有中断，需核对操作环境。',
                'limitations': '成人自评量表尚未提交，当前材料有限。',
            }],
        }],
        'plans': [{
            'id': 31, 'patient_id': 9, 'assessment_id': 3, 'responsible_doctor_id': 5,
            'status': 'active', 'revision': 2, 'current_plan_version_id': 42,
            'versions': [
                {'id': 41, 'version': 1, 'title': '旧记录安排', 'instructions': '旧版本执行文字。',
                 'start_date': '2026-10-01', 'end_date': '2026-10-03', 'cycle_id': 51},
                {'id': 42, 'version': 2, 'title': '晚间实际记录', 'instructions': '在晚间记录实际执行困难。',
                 'start_date': '2026-10-16', 'end_date': '2026-10-20', 'cycle_id': 52},
            ],
            'tasks': [
                {'id': 61, 'plan_version_id': 42, 'record_date': '2026-10-16', 'cycle_id': 52,
                 'status': 'completed', 'daily_record_id': 71},
                {'id': 62, 'plan_version_id': 42, 'record_date': '2026-10-17', 'cycle_id': 52,
                 'status': 'overdue', 'daily_record_id': None},
                {'id': 63, 'plan_version_id': 42, 'record_date': '2026-10-20', 'cycle_id': 52,
                 'status': 'pending', 'daily_record_id': None},
            ], 'receipts': [],
        }],
        'cycles': [{
            'id': 52, 'patient_id': 9, 'cycle_type': 'professional', 'plan_version_id': 42,
            'responsible_doctor_id': 5, 'start_date': '2026-10-16', 'end_date': '2026-10-20',
            'processing_status': 'active', 'records': [],
            'summary': {'as_of_date': '2026-10-18', 'completed_count': 1, 'due_count': 3,
                        'completed_dates': ['2026-10-16'], 'missing_dates': ['2026-10-17', '2026-10-18']},
        }],
    }


def draft(frame, intent):
    from backend.app.services.agent.artifacts import rule_artifact
    return rule_artifact(frame, {'intent': intent, 'patient_id': 9, 'assessment_id': 3,
                                 'cycle_id': None, 'message': '按本轮已保存资料准备，待负责医生核对。'})[0]


def test_quality_specific_questions_preserve_actual_original_and_unknown_reason():
    frame = actual_frame()
    interrupted = draft(frame, 'review_questions')
    frame['assessments'][0]['submissions'][0]['quality_reasons'] = ['high_omissions']
    omissions = draft(frame, 'review_questions')
    first, second = interrupted['questions'][0], omissions['questions'][0]
    assert first['question'] != second['question']
    assert '中断' in first['question'] and '漏答' in second['question']
    assert '抑制控制任务' in first['question']
    assert first['source_type'] == 'submission' and first['source_key'] == 'actual-task-original'
    assert first['source_refs'] == [frame['assessments'][0]['submissions'][0]['source_ref']]
    frame['assessments'][0]['submissions'][0]['quality_reasons'] = ['future_quality_code']
    unknown = draft(frame, 'review_questions')['questions'][0]
    assert unknown['actual_quality_reasons'] == ['future_quality_code']
    assert 'future_quality_code' in unknown['question'] and '待核对' in unknown['question']
    assert '中断' not in unknown['question'] and '漏答' not in unknown['question']


def test_missing_material_is_an_assessment_gap_and_does_not_invent_submission_or_background():
    frame = actual_frame()
    frame['assessments'][0]['submissions'] = []
    body = draft(frame, 'review_questions')
    assert body['questions'] == []
    gaps = body['missing_materials']
    assert {row['assessment_item_id'] for row in gaps} == {11, 12}
    assert all(row['source_refs'] == ['assessment:3:8'] for row in gaps)
    assert all('当前获准材料中未见' in row['suggested_question'] for row in gaps)
    assert 'submission:' not in json.dumps(body, ensure_ascii=False)


def test_plan_proposes_specific_edits_from_current_report_plan_tasks_and_real_coverage():
    frame = actual_frame()
    body = draft(frame, 'plan_draft')
    plan = body['plan_draft']
    assert plan['instructions'] != frame['plans'][0]['versions'][-1]['instructions']
    for text in ('晚间实际记录', '中断', '成人自评量表', '2026-10-17', '2026-10-18', '1 / 3', '操作环境'):
        assert text in plan['instructions']
    assert plan['source_report_id'] == 21 and plan['source_plan_version_id'] == 42
    assert plan['dates_status'] == 'requires_doctor_confirmation'
    assert 'start_date' not in plan and 'end_date' not in plan
    assert body['draft_method'] == 'local_structured_rules'
    assert 'plan:31:2' in plan['source_refs']
    assert any(ref.startswith('report:21:2:') for ref in plan['source_refs'])
    assert len(plan['edit_suggestions']) >= 3
    assert body['coverage_notes'][0]['missing_dates'] == ['2026-10-17', '2026-10-18']
    assert body['coverage_notes'][0]['future_dates'] == ['2026-10-20']
    assert '治疗有效' not in plan['instructions'] and '自动延长' not in plan['instructions']


def test_material_report_change_and_missing_task_change_both_change_primary_drafts():
    frame = actual_frame()
    first_plan, first_reply = draft(frame, 'plan_draft'), draft(frame, 'reply_draft')
    frame['assessments'][0]['reports'][0]['body'] = '本轮材料已补充，需核对练习步骤。'
    frame['assessments'][0]['submissions'].append({
        'submission_id': 'actual-scale-original', 'assessment_item_id': 12, 'attempt_id': 18,
        'kind': 'scale', 'quality_status': 'valid', 'quality_reasons': [],
        'source_ref': 'submission:actual-scale-original:' + 'c' * 64,
    })
    next_plan, next_reply = draft(frame, 'plan_draft'), draft(frame, 'reply_draft')
    assert first_plan['plan_draft']['instructions'] != next_plan['plan_draft']['instructions']
    assert first_reply['reply_draft']['text'] != next_reply['reply_draft']['text']
    assert next_reply['missing_materials'] == []
    assert '练习步骤' in next_plan['plan_draft']['instructions']
    assert '当前获准材料中未见“成人自评量表”' not in next_reply['reply_draft']['text']


def test_reply_gives_concrete_question_and_keeps_unknowns_and_separate_confirmation():
    body = draft(actual_frame(), 'reply_draft')
    text = body['reply_draft']['text']
    assert '抑制控制任务' in text and '中断' in text and '成人自评量表' in text
    assert '2026-10-17' in text and '1 / 3' in text
    assert '不知道' in text and '未记录' in text
    assert body['reply_draft']['recipient_confirmed'] is False
    assert body['requires_human_confirmation'] is True
    assert body['reply'] == text


def test_latest_report_and_current_plan_version_are_selected_by_identity_not_list_order():
    frame = actual_frame()
    session = frame['assessments'][0]
    older = {**session['reports'][0], 'id': 20, 'version': 1, 'body': '旧材料说明。'}
    session['reports'].append(older)
    frame['plans'][0]['versions'].reverse()
    plan = draft(frame, 'plan_draft')['plan_draft']
    assert plan['source_report_id'] == 21 and plan['source_plan_version_id'] == 42
    assert '晚间实际记录' in plan['instructions'] and '旧记录安排' not in plan['instructions']


def test_other_account_assessment_and_unrelated_cycle_never_enter_selected_draft():
    frame = actual_frame()
    unrelated = deepcopy(frame['assessments'][0])
    unrelated.update(id=4, patient_id=10, responsible_doctor_id=6, source_ref='assessment:4:8')
    unrelated['items'][0]['title'] = 'OTHER_ACCOUNT_MATERIAL'
    unrelated['submissions'][0].update(submission_id='OTHER_ACCOUNT_ORIGINAL', source_ref='submission:OTHER_ACCOUNT_ORIGINAL:bad')
    unrelated['reports'][0]['body'] = 'OTHER_ACCOUNT_REPORT'
    frame['assessments'].append(unrelated)
    frame['cycles'].append({**deepcopy(frame['cycles'][0]), 'id': 99, 'patient_id': 10,
                            'plan_version_id': 900, 'summary': {'missing_dates': ['1999-01-01']}})
    body = draft(frame, 'reply_draft')
    assert 'OTHER_ACCOUNT' not in json.dumps(body) and '1999-01-01' not in json.dumps(body)
    frame['assessments'][0]['responsible_doctor_id'] = 6
    with pytest.raises(HTTPException) as denied:
        draft(frame, 'reply_draft')
    assert denied.value.status_code == 403


def test_medical_report_text_does_not_become_new_prescription_or_diagnosis():
    frame = actual_frame()
    frame['assessments'][0]['reports'][0].update(
        body='诊断为某疾病。每天服用10mg药物，治疗有效。', limitations='调整药物剂量后再下结论。')
    frame['plans'][0]['versions'][-1]['instructions'] = '每天服用10mg药物。'
    for intent, field, text_key in [('plan_draft', 'plan_draft', 'instructions'), ('reply_draft', 'reply_draft', 'text')]:
        text = draft(frame, intent)[field][text_key]
        assert all(word not in text for word in ('10mg', '诊断为', '治疗有效', '调整药物剂量'))


def test_empty_report_and_missing_coverage_stay_unknown_and_do_not_choose_dates():
    frame = actual_frame()
    frame['plans'] = []; frame['cycles'] = []
    frame['assessments'][0]['reports'][0].update(body='', limitations='')
    plan = draft(frame, 'plan_draft')['plan_draft']
    assert plan['source_plan_version_id'] is None and '待医生确认' in plan['instructions']
    assert 'start_date' not in plan and 'end_date' not in plan
    frame['assessments'][0]['reports'] = []
    with pytest.raises(HTTPException):
        draft(frame, 'plan_draft')


def test_repeated_gaps_and_reasons_are_bounded_to_real_business_field_limits():
    frame = actual_frame()
    session = frame['assessments'][0]
    session['items'] += [{'id': index, 'title': '待补材料' * 90, 'kind': 'scale', 'execution_status': 'not_started'}
                         for index in range(100, 160)]
    session['submissions'][0]['quality_reasons'] = ['unknown_device', 'unknown_input', 'high_omissions'] * 20
    for intent in ('review_questions', 'plan_draft', 'reply_draft'):
        body = draft(frame, intent)
        assert body['missing_materials_total'] == 61 and len(body['missing_materials']) <= 12
        assert len(body.get('plan_draft', {}).get('instructions', '')) <= 4000
        assert len(body.get('reply_draft', {}).get('text', '')) <= 2000
        assert all(len(row['question']) <= 2000 for row in body.get('questions', []))


def test_current_responsible_doctor_can_reference_authorized_published_predecessor_opinion():
    frame = actual_frame()
    frame['assessments'][0]['reports'][0]['actor_user_id'] = 6
    plan = draft(frame, 'plan_draft')['plan_draft']
    assert plan['source_report_id'] == 21
    assert '操作环境' in plan['instructions']
