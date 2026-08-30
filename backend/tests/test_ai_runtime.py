from __future__ import annotations

from types import SimpleNamespace


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

    monkeypatch.setattr(ai_service.settings, "QWEN_API_KEY", "test-only-key")
    monkeypatch.setattr(ai_service.qwen_client, "chat", fake_chat)

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
