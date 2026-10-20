import json
import pytest
from time import monotonic

from backend.tests.test_agent_provider import frame_and_request, config, install_transport, final


@pytest.mark.parametrize('role,entry', [('researcher', '底部“用户”'), ('patient', '我的数据与报告')])
def test_imaging_location_answers_screenshot_question_for_actual_role(role, entry):
    from backend.app.services.agent.artifacts import rule_artifact
    frame, request = frame_and_request()
    frame['role'] = role
    request.update(intent='question', message='我应该在哪里看用户的影像报告')
    body, _, _ = rule_artifact(frame, request)
    assert body['question_topic'] == 'imaging_help'
    assert entry in body['reply'] and '已生成影像报告与实际审核版本' in body['reply']
    assert '医生意见' in body['reply'] and '原始影像' in body['reply']


@pytest.mark.parametrize('role,label', [('researcher', '医生助手'), ('patient', '用户助手')])
def test_role_and_notification_questions_explain_who_is_served_without_claiming_to_send(role, label):
    from backend.app.services.agent.artifacts import rule_artifact
    frame, request = frame_and_request()
    frame['role'] = role
    request.update(intent='question', message='你是在服务用户还是医生？')
    body, _, _ = rule_artifact(frame, request)
    assert label in body['reply'] and '不会自动' in body['reply']
    request['message'] = '下面是医生推送的消息还是你给我的回答？'
    body, _, _ = rule_artifact(frame, request)
    assert body['question_topic'] == 'notification_help'
    assert '业务提醒' in body['reply'] and '共享消息' in body['reply']


def test_published_report_location_does_not_fall_back_to_capability_introduction():
    from backend.app.services.agent.artifacts import rule_artifact
    frame, request = frame_and_request()
    request.update(intent='question', message='医生的报告在哪里看？')
    body, _, _ = rule_artifact(frame, request)
    assert body['question_topic'] == 'report_help'
    assert '底部“评估”' in body['reply'] and '医生意见' in body['reply']


def test_greeting_and_optional_background_help_answer_the_actual_question_without_draft_instructions():
    from backend.app.services.agent.artifacts import rule_artifact
    frame, request = frame_and_request()
    request.update(intent='question', message='你好')
    body, _, _ = rule_artifact(frame, request)
    assert '你好' in body['reply'] and '星仔' in body['reply']
    assert '草稿' not in body['reply'] and '已按当前获准' not in body['reply']
    assert body['question_topic'] == 'greeting'
    request['message'] = '背景资料不知道，可以跳过吗？'
    body, _, _ = rule_artifact(frame, request)
    assert '可以跳过' in body['reply'] and '没有这种情况' in body['reply']


def test_progress_answer_uses_program_counts_and_difficulty_does_not_claim_a_completed_test():
    from backend.app.services.agent.artifacts import rule_artifact
    frame, request = frame_and_request()
    request.update(intent='question', message='这一轮材料齐全了吗？')
    body, _, _ = rule_artifact(frame, request)
    assert '0 项提交' in body['reply'] and '1 项未提交' in body['reply']
    request['message'] = '我测试时跟不上，感觉太难了'
    body, _, _ = rule_artifact(frame, request)
    assert '新尝试' in body['reply'] and '正式完成' in body['reply']


def test_configured_business_question_can_use_real_provider_protocol_without_transmitting_free_text(monkeypatch):
    from backend.app.services.agent.artifacts import rule_artifact
    frame, request = frame_and_request()
    request.update(intent='question', message='评估怎么开始 PRIVATE_FREE_MESSAGE')
    provider, sent = install_transport(monkeypatch, [final()])
    authorization_checks = []
    body, _, metrics = provider.run_provider(frame, request, settings=config(),
        authorize_dispatch=lambda **kw: authorization_checks.append(kw), execute_authorized_tool=lambda *_: {}, deadline=monotonic()+60)
    assert len(sent) == len(authorization_checks) == metrics['model_round_count'] == 1
    assert body['provider_narrative'] is True
    assert 'PRIVATE_' not in json.dumps(sent)
    assert json.loads(sent[0]['messages'][1]['content'])['question_topic'] == 'assessment_help'
    assert rule_artifact(frame, request)[0]['question_topic'] == 'assessment_help'
