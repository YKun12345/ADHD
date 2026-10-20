"""Fresh quality probes for W05 consumers, using disposable synthetic stores."""
import re
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, inspect, select, update
from sqlalchemy.schema import CreateTable

from backend.tests.test_assessment_consumers import drain
from backend.tests.test_care_suspension import current_consent, withdraw
from backend.tests.test_submission_cognitive_evidence import cognitive_submission
from backend.tests.test_submission_context import scale_submission


@pytest.mark.parametrize("table_name", ["care_event_deliveries", "attention_items"])
def test_existing_sensitive_tables_require_actual_business_uniqueness(tmp_path, table_name):
    from backend.app import models
    from backend.app.db.base import Base
    from backend.app.db.care_migration import require_care_schema, schema_plan

    engine = create_engine(f"sqlite:///{(tmp_path / 'missing-unique.db').as_posix()}")
    try:
        Base.metadata.create_all(engine)
        table = Base.metadata.tables[table_name]
        ddl = str(CreateTable(table).compile(dialect=engine.dialect))
        weakened, count = re.subn(r",\s*CONSTRAINT uq_\w+ UNIQUE \([^)]*\)", "", ddl)
        assert count == 1
        with engine.begin() as connection:
            connection.exec_driver_sql(f"DROP TABLE {table_name}")
            connection.exec_driver_sql(weakened)
        before = {column["name"] for column in inspect(engine).get_columns(table_name)}
        assert before == set(table.columns.keys())
        plan = schema_plan(engine)
        assert plan["missing_columns"] == {}
        assert plan["missing_constraints"][table_name]
        with pytest.raises(RuntimeError, match="explicit|reviewed"):
            require_care_schema(engine)
        assert inspect(engine).get_unique_constraints(table_name) == []
        print({"missing_unique_table": table_name, "guard": "rejected_without_automatic_repair"})
    finally:
        engine.dispose()


@pytest.mark.parametrize("changed", [{"status": "closed"}, {"created_for_user_id": 99999}])
def test_tampered_attention_is_withheld_and_cannot_partially_commit_suspension(client, changed):
    from backend.app.db.session import SessionLocal
    from backend.app.models.assessment import AssessmentSession
    from backend.app.models.attention import AttentionItem
    from backend.app.models.event import CareEventDelivery
    from backend.app.models.submission import SubmissionRecord
    from backend.app.services.care_consumers import consumer_handlers
    from backend.app.workers.care_worker import run_once

    owner, session, _, _, body = cognitive_submission(client, "flanker")
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    committed = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert committed.status_code == 201 and committed.json()["quality_status"] == "limited", committed.text
    assert drain() == 2
    with SessionLocal() as db:
        attention = db.scalar(select(AttentionItem))
        attention_id = attention.id
        db.execute(update(AttentionItem.__table__).where(AttentionItem.id == attention_id).values(**changed))
        db.commit()
    denied = client.get(f"/api/v1/care/patient/attention?patient_id={body['patient_id']}", headers=owner)
    assert denied.status_code == 503, denied.text
    assert body["submission_id"] not in denied.text and "execution_interrupted" not in denied.text
    # A changed terminal status is outside the invalidation selection by design;
    # the changed source case still has an open item and must reject all writes.
    if "created_for_user_id" in changed:
        withdraw(client, owner, current_consent(client, owner, "basic_use"))
        handler = {"care_authority_invalidation": consumer_handlers()["care_authority_invalidation"]}
        assert run_once(SessionLocal, handler, clock=lambda: datetime.now(timezone.utc)) is False
        with SessionLocal() as db:
            assert db.get(AssessmentSession, session["id"]).status == "active"
            delivery = db.scalar(select(CareEventDelivery).where(CareEventDelivery.consumer == "care_authority_invalidation"))
            assert delivery.status == "retry_failed" and delivery.completed_at is None
            assert delivery.last_error == "RecordIntegrityError"
            assert db.scalar(select(SubmissionRecord.id).where(SubmissionRecord.submission_id == body["submission_id"])) is not None
            assert db.get(AttentionItem, attention_id).status == "open"
            print({"tampered_source_suspension": "rolled_back", "assessment": "active", "delivery": delivery.status})
    print({"tampered_attention_fields": list(changed), "http_status": denied.status_code})


@pytest.mark.parametrize("authority_kind", ["qualification", "original_clinical_consent"])
def test_doctor_attention_read_rechecks_independent_authority_at_final_audit(client, monkeypatch, authority_kind):
    from backend.app.db.session import SessionLocal
    from backend.app.models.consent import ConsentRecord
    from backend.app.models.identity import DoctorQualification
    from backend.app.services import authorization_ledger, security_service

    owner, clinician, session, _, _, scale = scale_submission(client, doctor=True, suffix="quality-final-read")
    _, _, item, _, body = cognitive_submission(client, "flanker", context=(owner, session, scale["patient_id"]))
    body["task_id"] = item["patient_task_id"]
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    committed = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert committed.status_code == 201 and committed.json()["quality_status"] == "limited", committed.text
    assert drain() == 2
    queue_url = "/api/v1/care/doctor/work_queue"
    assert len(client.get(queue_url, headers=clinician).json()["items"]) == 1
    original = security_service._append_audit_log
    denied = []

    def invalidate_at_read_audit(db, **kwargs):
        if kwargs.get("action") == "data_read" and kwargs.get("detail_json", {}).get("scope") == "assessment_attention" and not denied:
            with SessionLocal() as independent:
                if authority_kind == "qualification":
                    row = independent.scalar(select(DoctorQualification).where(DoctorQualification.user_id == session["responsible_doctor_id"]))
                else:
                    row = independent.scalar(select(ConsentRecord).where(ConsentRecord.patient_id == scale["patient_id"],
                        ConsentRecord.purpose == "clinical_sharing", ConsentRecord.status == "active"))
                assert row is not None
                authorization_ledger.deny(row)
                assert authorization_ledger.matches(row) is False
                denied.append(row.ledger_key)
        return original(db, **kwargs)

    monkeypatch.setattr(security_service, "_append_audit_log", invalidate_at_read_audit)
    response = client.get(queue_url, headers=clinician)
    assert len(denied) == 1
    assert response.status_code in {403, 409}, response.text
    assert body["submission_id"] not in response.text
    assert "execution_interrupted" not in response.text and "assessment_quality" not in response.text
    print({"late_read_authority_denied": authority_kind, "http_status": response.status_code, "evidence_withheld": True})
