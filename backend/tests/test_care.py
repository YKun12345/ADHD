from __future__ import annotations

from datetime import datetime, timedelta, timezone
import sqlite3


def register(client, *, email: str, role: str, name: str):
    payload = {
        "email": email,
        "password": "CareTest#2026",
        "full_name": name,
        "role": role,
        "consent_agreed": role == "patient",
    }
    if role == "patient":
        payload["patient_profile"] = {
            "age": 20,
            "gender": "female",
            "patient_type": "adult",
        }
    response = client.post("/api/v1/auth/register", json=payload)
    assert response.status_code == 201, response.text
    body = response.json()
    return body["user"], {"Authorization": f"Bearer {body['access_token']}"}


def bind(client, doctor_headers, patient_email: str) -> int:
    from backend.tests.w02_helpers import qualify
    doctor_id = client.get('/api/v1/auth/me',headers=doctor_headers).json()['id']
    qualify(doctor_id)
    response = client.post(
        "/api/v1/doctor/bind_patient",
        headers=doctor_headers,
        json={"patient_email": patient_email},
    )
    assert response.status_code == 200, response.text
    invitation = response.json()
    assert invitation['status'] == 'pending'
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.core.security import create_access_token
    from sqlalchemy import select
    with SessionLocal() as db:
        patient_user = db.scalar(select(User).where(User.email == patient_email))
        patient_headers = {'Authorization':'Bearer '+create_access_token(str(patient_user.id),patient_user.role.value)}
    accepted = client.post(f"/api/v1/care/relationships/{invitation['id']}/accept",headers=patient_headers,json={'expected_revision':1})
    assert accepted.status_code == 200 and accepted.json()['status'] == 'active',accepted.text
    patients = client.get("/api/v1/doctor/my_patients", headers=doctor_headers).json()["items"]
    return patients[0]["patient_id"]


def test_task_due_date_state_constraints(client, sqlite_database_path) -> None:
    _, doctor = register(client, email="care-doctor@example.com", role="researcher", name="Care Doctor")
    _, patient = register(client, email="care-patient@example.com", role="patient", name="Care Patient")
    patient_id = bind(client, doctor, "care-patient@example.com")

    past_due_at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    rejected = client.post(
        f"/api/v1/care/doctor/patient/{patient_id}/tasks",
        headers=doctor,
        json={"task_type": "scale", "task_title": "过期任务", "task_description": "不要创建", "due_at": past_due_at},
    )
    assert rejected.status_code == 422

    due_at = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    created = client.post(
        f"/api/v1/care/doctor/patient/{patient_id}/tasks",
        headers=doctor,
        json={
            "task_type": "scale",
            "task_title": "完成量表",
            "task_description": "请在安静环境填写",
            "due_at": due_at,
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["due_at"] is not None
    assert created.json()["status"] == "pending"
    assert created.json()["researcher_name"] == "Care Doctor"

    task_id = created.json()["id"]
    listed = client.get("/api/v1/care/patient/tasks", headers=patient)
    assert listed.status_code == 200
    assert listed.json()["items"][0]["status"] == "pending"

    completed = client.post(f"/api/v1/care/patient/tasks/{task_id}/complete", headers=patient)
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
    completed_at = completed.json()["completed_at"]
    repeated = client.post(f"/api/v1/care/patient/tasks/{task_id}/complete", headers=patient)
    assert repeated.status_code == 200
    assert repeated.json()["completed_at"] == completed_at

    second = client.post(
        f"/api/v1/care/doctor/patient/{patient_id}/tasks",
        headers=doctor,
        json={"task_type": "tracking", "task_title": "每日记录", "task_description": "完成快速记录", "due_at": due_at},
    )
    second_id = second.json()["id"]
    with sqlite3.connect(sqlite_database_path) as connection:
        connection.execute(
            "UPDATE patient_tasks SET due_at = ? WHERE id = ?",
            ((datetime.now(timezone.utc) - timedelta(hours=2)).strftime("%Y-%m-%d %H:%M:%S.%f"), second_id),
        )
    expired = client.post(f"/api/v1/care/patient/tasks/{second_id}/complete", headers=patient)
    assert expired.status_code == 409
    doctor_summary = client.get(f"/api/v1/care/doctor/patient/{patient_id}/summary", headers=doctor)
    assert doctor_summary.json()["pending_task_count"] == 0


def test_message_unread_counts_and_read_receipts(client) -> None:
    doctor_user, doctor = register(client, email="message-doctor@example.com", role="researcher", name="Message Doctor")
    patient_user, patient = register(client, email="message-patient@example.com", role="patient", name="Message Patient")
    patient_id = bind(client, doctor, "message-patient@example.com")

    def original_payload(headers, content, client_id):
        selected = client.get(f"/api/v1/care/shared-messages/relationships?patient_id={patient_id}",headers=headers)
        assert selected.status_code == 200, selected.text
        relationship = selected.json()["items"][0]
        return {"patient_id":patient_id,"relationship_id":relationship["relationship_id"],
            "send_context":relationship["send_context"],"confirmed":True,
            "content":content,"client_message_id":client_id}

    sent = client.post(
        "/api/v1/care/shared-messages",
        headers=doctor,
        json=original_payload(doctor,"请按时完成任务","doctor-message-001"),
    )
    assert sent.status_code == 201, sent.text
    assert sent.json()["sender_user_id"] == doctor_user["id"]
    assert client.get("/api/v1/auth/me",headers=doctor).json()["full_name"] == "Message Doctor"

    summary = client.get("/api/v1/care/patient/summary", headers=patient)
    assert summary.status_code == 200
    assert summary.json()["unread_message_count"] == 1

    read = client.post(f"/api/v1/care/shared-messages/{sent.json()['message_id']}/read", headers=patient)
    assert read.status_code == 200
    assert read.json()["viewer_user_id"] == patient_user["id"]
    assert read.json()["message_id"] == sent.json()["message_id"]
    assert client.get("/api/v1/care/patient/summary", headers=patient).json()["unread_message_count"] == 0

    reply_payload = original_payload(patient,"已经收到","patient-message-001")
    reply = client.post(
        "/api/v1/care/shared-messages",
        headers=patient,
        json=reply_payload,
    )
    assert reply.status_code == 201
    repeated = client.post(
        "/api/v1/care/shared-messages",
        headers=patient,
        json=reply_payload,
    )
    assert repeated.status_code == 200
    assert repeated.json()["message_id"] == reply.json()["message_id"]
    listed = client.get(f"/api/v1/care/shared-messages?patient_id={patient_id}&relationship_id={reply_payload['relationship_id']}", headers=patient)
    assert len([item for item in listed.json()["items"] if item["content"] == "已经收到"]) == 1
    conflict = client.post(
        "/api/v1/care/shared-messages",
        headers=patient,
        json={**reply_payload,"content":"不同内容"},
    )
    assert conflict.status_code == 409
    doctor_summary = client.get(
        f"/api/v1/care/doctor/patient/{patient_id}/summary", headers=doctor
    )
    assert doctor_summary.status_code == 200
    assert doctor_summary.json()["unread_message_count"] == 1
    marked = client.post(
        f"/api/v1/care/shared-messages/{reply.json()['message_id']}/read", headers=doctor
    )
    assert marked.status_code == 200, marked.text
    assert marked.json()["viewer_user_id"] == doctor_user["id"]
    assert marked.json()["message_id"] == reply.json()["message_id"]
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/summary",headers=doctor).json()["unread_message_count"] == 0

    assert client.post(
        f"/api/v1/care/doctor/patient/{patient_id}/messages",
        headers=doctor,
        json={"content": "   ", "client_message_id": "doctor-message-blank"},
    ).status_code == 422
    assert client.post(
        "/api/v1/care/patient/messages", headers=patient, json={"content": "\t", "client_message_id": "patient-message-blank"}
    ).status_code == 422
    assert client.post(
        f"/api/v1/care/doctor/patient/{patient_id}/tasks",
        headers=doctor,
        json={"task_type": "scale", "task_title": "   "},
    ).status_code == 422
    assert client.post(
        f"/api/v1/care/doctor/patient/{patient_id}/tasks",
        headers=doctor,
        json={"task_type": "scale", "task_title": "标题", "task_description": "   "},
    ).status_code == 422


def test_researcher_cannot_access_unassigned_patient_care(client) -> None:
    _, doctor = register(client, email="owner@example.com", role="researcher", name="Owner Doctor")
    _, stranger = register(client, email="stranger@example.com", role="researcher", name="Stranger Doctor")
    _, _patient = register(client, email="owned@example.com", role="patient", name="Owned Patient")
    patient_id = bind(client, doctor, "owned@example.com")

    response = client.get(
        f"/api/v1/care/doctor/patient/{patient_id}/summary", headers=stranger
    )
    assert response.status_code == 403
    requests = [
        ("get", f"/api/v1/care/doctor/patient/{patient_id}/tasks", None),
        ("post", f"/api/v1/care/doctor/patient/{patient_id}/tasks", {"task_type": "scale", "task_title": "越权", "task_description": "越权说明"}),
        ("get", f"/api/v1/care/doctor/patient/{patient_id}/messages", None),
        ("post", f"/api/v1/care/doctor/patient/{patient_id}/messages", {"content": "越权", "client_message_id": "stranger-message-001"}),
        ("post", f"/api/v1/care/doctor/patient/{patient_id}/messages/read", None),
        ("get", f"/api/v1/care/doctor/patient/{patient_id}/ai_logs", None),
    ]
    for method, url, payload in requests:
        request = getattr(client, method)
        result = request(url, headers=stranger, **({"json": payload} if payload is not None else {}))
        assert result.status_code == 403, (method, url, result.text)
