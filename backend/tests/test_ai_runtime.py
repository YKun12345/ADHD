from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError


def test_chat_style_is_natural_and_keeps_twelve_recent_messages() -> None:
    from backend.app.services import ai_service

    assert "不固定套用" in ai_service.AI_STYLE_PROMPT
    assert "短问题可以短回答" in ai_service.AI_STYLE_PROMPT

    conversation = [
        {"role": "user" if index % 2 == 0 else "assistant", "content": f"turn-{index}"}
        for index in range(14)
    ]
    trimmed = ai_service._trim_conversation(conversation)
    assert len(trimmed) == 12
    assert trimmed[0]["content"] == "turn-2"


def test_current_question_is_not_duplicated_into_system_messages() -> None:
    from backend.app.services import ai_service

    question = "为什么我一开始任务就容易走神？"
    messages = ai_service._build_chat_messages(
        user_message=question,
        conversation=[],
        context_scope="general",
        snapshot={"patient_profile": {"patient_type": "adult"}, "tracking": {}},
    )

    assert messages[-1] == {"role": "user", "content": question}
    assert all(
        question not in message["content"]
        for message in messages
        if message["role"] == "system"
    )


def test_chat_reasoning_mode_matches_scope(monkeypatch) -> None:
    from backend.app.services import ai_service

    calls: list[dict[str, object]] = []

    def fake_chat(**kwargs):
        calls.append(kwargs)
        return ai_service.AIProviderResult(content="自然回答", model="test-model")

    monkeypatch.setattr(ai_service.settings, "DEEPSEEK_API_KEY", "test-only-key")
    monkeypatch.setattr(ai_service.deepseek_client, "chat", fake_chat)
    snapshot = {"patient_profile": {"patient_type": "adult"}, "tracking": {}}

    ai_service.generate_chat_reply(
        message="你好",
        conversation=[],
        context_scope="general",
        snapshot=snapshot,
    )
    ai_service.generate_chat_reply(
        message="帮我分析最近的变化",
        conversation=[],
        context_scope="tracking",
        snapshot=snapshot,
    )

    assert calls[0]["thinking"] is False
    assert calls[0]["temperature"] == 0.7
    assert "reasoning_effort" not in calls[0]
    assert calls[1]["thinking"] is True
    assert calls[1]["reasoning_effort"] == "low"
    assert "temperature" not in calls[1]


def test_deepseek_client_serializes_thinking_options(monkeypatch) -> None:
    from backend.app.services import ai_service

    payloads: list[dict[str, object]] = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps({
                "model": "test-model",
                "choices": [{"message": {"content": "回答"}}],
            }).encode("utf-8")

    def fake_urlopen(request, timeout):
        assert timeout == ai_service.settings.DEEPSEEK_TIMEOUT_SECONDS
        payloads.append(json.loads(request.data.decode("utf-8")))
        return FakeResponse()

    monkeypatch.setattr(ai_service.settings, "DEEPSEEK_API_KEY", "test-only-key")
    monkeypatch.setattr(ai_service, "urlopen", fake_urlopen)

    ai_service.deepseek_client.chat(
        model="test-model",
        messages=[{"role": "user", "content": "分析"}],
        thinking=True,
        reasoning_effort="low",
    )
    ai_service.deepseek_client.chat(
        model="test-model",
        messages=[{"role": "user", "content": "你好"}],
        thinking=False,
        temperature=0.7,
    )

    assert payloads[0]["thinking"] == {"type": "enabled"}
    assert payloads[0]["reasoning_effort"] == "low"
    assert "temperature" not in payloads[0]
    assert payloads[1]["thinking"] == {"type": "disabled"}
    assert payloads[1]["temperature"] == 0.7


def test_chat_fallback_is_logged_without_user_content(monkeypatch, caplog) -> None:
    from backend.app.services import ai_service

    private_question = "这是不应出现在日志里的用户问题"

    def fail_chat(**_kwargs):
        raise ai_service.AIProviderError("rate limited")

    monkeypatch.setattr(ai_service.settings, "DEEPSEEK_API_KEY", "test-only-key")
    monkeypatch.setattr(ai_service.deepseek_client, "chat", fail_chat)

    with caplog.at_level("WARNING"):
        _reply, model, degraded = ai_service.generate_chat_reply(
            message=private_question,
            conversation=[],
            context_scope="general",
            snapshot={"patient_profile": {"patient_type": "adult"}, "tracking": {}},
        )

    assert model == "fallback-template"
    assert degraded is True
    assert "DeepSeek chat unavailable" in caplog.text
    assert private_question not in caplog.text


def test_response_provider_distinguishes_deepseek_and_local() -> None:
    from backend.app.api.routes import ai as ai_routes
    from backend.app.schemas.ai import AIChatResponse

    assert ai_routes._provider_name("deepseek-v4-flash", False) == "deepseek"
    assert ai_routes._provider_name("fallback-template", True) == "local"
    assert ai_routes._provider_name("safety-guard", True) == "local"

    with pytest.raises(ValidationError):
        AIChatResponse(
            reply="回答",
            model="unknown",
            provider="unknown",
            disclaimer="提示",
        )


def test_provider_reminder_uses_dedicated_system_prompt(monkeypatch) -> None:
    from backend.app.services import ai_service

    captured: dict[str, object] = {}

    def fake_chat(**kwargs):
        captured.update(kwargs)
        return ai_service.AIProviderResult(
            content=(
                '{"title":"今日提醒","message":"花一分钟记录一下今天的状态。",'
                '"action_label":"开始记录"}'
            ),
            model="test-reminder-model",
        )

    monkeypatch.setattr(ai_service.settings, "DEEPSEEK_API_KEY", "test-only-key")
    monkeypatch.setattr(ai_service.deepseek_client, "chat", fake_chat)

    response, model, is_fallback = ai_service._provider_or_fallback_reminder(
        {
            "tracking": {
                "current_day": 2,
                "completed_count": 1,
                "consecutive_missed_days": 0,
                "completion_status": "in_progress",
            }
        },
        tone="gentle",
    )

    assert captured["messages"][0] == {
        "role": "system",
        "content": ai_service.REMINDER_SYSTEM_PROMPT,
    }
    assert response["title"] == "今日提醒"
    assert model == "test-reminder-model"
    assert is_fallback is False


def test_natural_language_patient_search_resolves_model_dependencies() -> None:
    from backend.app.services.natural_language_query_service import (
        NaturalLanguageQueryService,
        QueryIntent,
    )

    class EmptyScalars:
        def all(self):
            return []

    class FakeDatabase:
        def get(self, _model, _identifier):
            return SimpleNamespace(full_name="Test Patient")

        def scalar(self, _statement):
            return None

        def scalars(self, _statement):
            return EmptyScalars()

    patient = SimpleNamespace(
        id=1,
        user_id=2,
        patient_type=SimpleNamespace(value="adult"),
        age=20,
    )
    intent = QueryIntent(
        intent_type="patient_search",
        entities={},
        time_range=None,
        metrics=[],
        filters={},
    )

    result = NaturalLanguageQueryService(FakeDatabase())._execute_patient_search(
        [patient],
        intent,
    )

    assert result["total_patients"] == 1
    assert result["patients"][0]["patient_name"] == "Test Patient"
