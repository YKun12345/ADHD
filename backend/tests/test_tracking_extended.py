from __future__ import annotations


def test_extended_tracking_fields_round_trip_and_validate(client) -> None:
    registration = client.post("/api/v1/auth/register", json={
        "email": "tracking-extended@example.com",
        "password": "Tracking#2026",
        "full_name": "Tracking Patient",
        "role": "patient",
        "consent_agreed": True,
        "patient_profile": {"age": 20, "gender": "female", "patient_type": "adult"},
    })
    assert registration.status_code == 201, registration.text
    headers = {"Authorization": f"Bearer {registration.json()['access_token']}"}
    payload = {
        "day_index": 1, "mood_tag": "4", "focus_minutes": 60,
        "attention_rating": 4, "hyperactivity_rating": 2, "impulsivity_rating": 1,
        "emotion_rating": 4, "task_completion_rating": 3, "sleep_quality": "good",
        "appetite_quality": "normal", "has_conflict": False, "was_criticized": True,
        "side_effects": "无", "activities": ["学习", "运动"],
        "special_events": "阶段测验", "highlights": "主动完成作业",
    }
    response = client.post("/api/v1/patient/submit_daily_log", headers=headers, json=payload)
    assert response.status_code == 201, response.text
    body = response.json()
    for key, value in payload.items():
        assert body[key] == value

    invalid = dict(payload, attention_rating=6, day_index=2)
    assert client.post("/api/v1/patient/submit_daily_log", headers=headers, json=invalid).status_code == 422

    invalid_tag = dict(payload, activities=["学习,运动"], day_index=2)
    assert client.post("/api/v1/patient/submit_daily_log", headers=headers, json=invalid_tag).status_code == 422
